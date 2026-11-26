"""Compare counterbalanced fresh launches, with the launch as the repeat unit."""
from itertools import combinations
import math
import re
from statistics import median

from burst import read_json, trace_clean
from catalog import offset_for, require
from warm import measure

METRICS = ("keyToRenderMs", "keyToSwapCompleteMs")
AFTER_APPLY = ("keyToSecondApplyEndMs", "keyToPostApplyRenderMs", "keyToPostApplySwapMs")


def describe(values):
    values = sorted(values)
    return {"n": len(values), "median": median(values),
            "p95": values[math.ceil(.95 * len(values)) - 1], "worst": values[-1]}


def metrics_for(post_apply, attributed):
    if attributed:
        return METRICS + ("keyToRequiredApplyEndMs",) + AFTER_APPLY[1:]
    return METRICS + AFTER_APPLY if post_apply else METRICS


def launch(path, post_apply, attributions=None):
    replay = read_json(path / "replay/summary.json")
    require(replay["pass"] and replay["cohort"] == "trace" and not replay["failedInputs"]
            and not replay["unattemptedInputs"], "incomplete or failed warm replay")
    trace_clean(path / "trace-stats.csv")
    summary = read_json(path / "device-summary.json")
    proof = attributions[replay["artifact"]["sha256"]] if attributions is not None else None
    samples = measure(path, attribution=proof)["samples"] if post_apply else summary["samples"]
    metrics = metrics_for(post_apply, attributions is not None)
    schedule = replay["schedule"]
    require(not summary["missingTailMoves"] and len(samples) == len(schedule) > 0,
            "missing trace endpoints")
    facts = replay["facts"]
    hardware = tuple(facts[k] for k in ("model", "firmware", "firmwareBuild", "uiResolution"))
    require(all(hardware), "missing device configuration")
    sha = replay["artifact"]["sha256"]
    require(re.fullmatch("[0-9a-f]{64}", sha), "missing artifact identity")
    strata = {"overall": [], "scrolling": [], "nonScrolling": []}
    offset = 0
    for step, sample in zip(schedule, samples):
        require(all(sample[k] == step[k] for k in ("key", "from", "to")), "schedule mismatch")
        require(all(isinstance(sample[m], (int, float)) and math.isfinite(sample[m])
                    and sample[m] >= 0 for m in metrics), "missing or invalid latency")
        new_offset = offset_for(step["to"], offset)
        strata["scrolling" if new_offset != offset else "nonScrolling"].append(sample)
        strata["overall"].append(sample)
        offset = new_offset
    metadata = (hardware, replay["spacingMs"], replay["warmup"], schedule, summary["deviceClock"])
    return sha, metadata, {s: {m: [r[m] for r in rows] for m in metrics}
                           for s, rows in strata.items() if rows}


def compare(manifest_path, post_apply=False, attributions=None):
    metrics = metrics_for(post_apply, attributions is not None)
    spec = read_json(manifest_path)
    blocks = spec["blocks"]
    require(len(blocks) >= 2, "need both run orders")
    roles = ("control", "candidate")
    require({tuple(b["order"]) for b in blocks} == {roles, roles[::-1]}, "need both run orders")
    hashes, paths, launches, results = {}, set(), [], []
    exclusions = spec.get("excludedAttempts", [])
    for attempt in exclusions:
        require(attempt.get("reason") and attempt.get("path"), "excluded attempts need path and reason")
        p = (manifest_path.parent / attempt["path"]).resolve()
        require(p.is_dir() and p not in paths, "missing or duplicate excluded attempt")
        paths.add(p)
    reference = None
    by_role = {r: [] for r in roles}
    repeated = {r: [] for r in roles}
    for block in blocks:
        current = {}
        for role in block["order"]:
            path = (manifest_path.parent / block[role]).resolve()
            require(path not in paths, "a launch was reused")
            paths.add(path)
            sha, metadata, strata = launch(path, post_apply, attributions)
            if reference is None:
                reference = metadata
            require(metadata == reference, "different device configuration, schedule or clock")
            require(hashes.setdefault(role, sha) == sha, "artifact changed between orders")
            current[role] = strata
            repeated[role].append((str(path), strata))
            stats = {s: {m: describe(v) for m, v in ms.items()} for s, ms in strata.items()}
            by_role[role].append(stats)
            launch_result = {"role": role, "path": str(path), "sha256": sha, "metricsMs": stats}
            if attributions is not None:
                launch_result["postApplySwapMs"] = strata["overall"]["keyToPostApplySwapMs"]
            launches.append(launch_result)
        a, b = current["control"], current["candidate"]
        savings = {s: {m: describe([x-y for x, y in zip(a[s][m], b[s][m])])
                       for m in metrics} for s in a}
        results.append({"order": block["order"], "matchedSavedMs": savings, "matchedMedianSavedMs": {
            s: {m: savings[s][m]["median"] for m in metrics} for s in a}})
    ranges = {r: {s: {m: max(x[s][m]["median"] for x in by_role[r])
                         - min(x[s][m]["median"] for x in by_role[r]) for m in metrics}
                  for s in by_role[r][0]} for r in roles}
    same_build = []
    for role in roles:
        for (a_path, a), (b_path, b) in combinations(repeated[role], 2):
            same_build.append({"role": role, "runs": [a_path, b_path], "medianAbsMatchedMs": {
                s: {m: median(abs(x-y) for x, y in zip(a[s][m], b[s][m])) for m in metrics}
                for s in a}})
    return {"sameBuildMatchedNoise": same_build, "launches": launches, "blocks": results, "withinBuildLaunchMedianRangeMs": ranges,
            "identicalArtifacts": hashes["control"] == hashes["candidate"],
            "excludedAttempts": exclusions, "firstVisibleHighlight": "UNMEASURED"}
