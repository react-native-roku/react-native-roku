"""Build a portable shelf comparison from two prepared fixtures and private Ultra traces."""
from datetime import datetime
from hashlib import sha256
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from zipfile import ZipFile

from burst import read_json
from catalog import native_snapshot, offset_for, require, verify_snapshot
from xml.etree.ElementTree import ParseError
from compare import compare
from warm import measure

HERE = Path(__file__).resolve().parent
ENDPOINT = "keyToPostApplySwapMs"
FACTS = ("model", "firmware", "firmwareBuild", "uiResolution", "outputMode")
STRATA = ("overall", "nonScrolling", "scrolling")


def digest(path):
    h = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_trace(path, processor):
    trace = path / "device.perfetto-trace"
    require(trace.stat().st_size > 0, "empty trace")
    for query, saved in ((HERE / "trace-quality.sql", "trace-stats.csv"),
                         (HERE.parent / "shelf/timeline.sql", "timeline.csv"),
                         (HERE / "attribution.sql", "attribution.csv")):
        result = subprocess.run([str(processor), "-q", str(query), str(trace)], capture_output=True)
        require(result.returncode == 0, f"trace processor failed to extract {saved}")
        require(sha256(result.stdout).hexdigest() == digest(path / saved),
                f"raw trace disagrees with archived {saved}")
    summary = subprocess.check_output([sys.executable, str(HERE.parent / "shelf/trace-summary.py"),
                                       str(path)])
    require(json.loads(summary) == read_json(path / "device-summary.json"),
            "raw trace disagrees with sample summary")
    return digest(trace)


def frozen_route():
    source = 'import {schedule,warmup} from "./score.mjs";console.log(JSON.stringify({schedule,warmup}))'
    return json.loads(subprocess.check_output(["node", "--input-type=module", "-e", source],
                      cwd=HERE.parent / "shelf", env=dict(os.environ, ROKU_SHELF_WORKLOAD="catalog")))


def configuration(replay, renderer, expected_zip, route):
    require(replay["mode"] == renderer and replay["artifact"]["sha256"] == expected_zip,
            "launch renderer or ZIP differs from its prepared fixture")
    require(replay["warmup"] == route["warmup"] and replay["schedule"] == route["schedule"],
            "launch differs from the frozen warmup or route")
    require(replay["pass"] is True and replay["failedInputs"] == replay["unattemptedInputs"] == 0,
            "an input failed or was skipped")
    require(len(replay["results"]) == len(route["schedule"]) and
            all(r["pass"] is True and all(r[k] == s[k] for k in ("key", "from", "to"))
                for r, s in zip(replay["results"], route["schedule"])), "incomplete input outcomes")
    facts = {key: replay["facts"][key] for key in FACTS}
    require(all(isinstance(v, str) and v.strip() for v in facts.values()), "incomplete device facts")
    return {"device": facts, "spacingMs": replay["spacingMs"], "pollMs": replay["pollMs"],
            "deadlineMs": replay["deadlineMs"]}


def verify_settled(path, route):
    steps = [read_json(path / "replay" / f"step-{i:02d}.json")
             for i in range(1, len(route["schedule"]) + 1)]
    offset = 0
    for s in route["warmup"]:
        offset = offset_for(s["to"], offset)
    for i, (observed, planned) in enumerate(zip(steps, route["schedule"])):
        require(all(observed[k] == planned[k] for k in ("key", "from", "to")),
                "per-input evidence differs from frozen route")
        offset = offset_for(planned["to"], offset)
        polls = list(observed["polls"])
        if i + 1 < len(steps):
            polls.append(steps[i + 1]["before"])
        for poll in polls:
            try:
                state = native_snapshot(poll["xml"])
            except (KeyError, ValueError, ParseError):
                continue
            if verify_snapshot(state, planned["to"], offset):
                break
        else:
            raise ValueError(f"missing settled title, focus, paint or scroll at step {i + 1}")


def fixture(build, marked, renderer, route, processor):
    inputs = read_json(build / "inputs.json")
    require(inputs["catalog"] is True and inputs["marks"] is False and inputs["activation"] is False,
            "expected the ordinary unmarked catalog")
    name = "react" if renderer == "react" else "solid-full"
    if renderer == "solid":
        require(inputs.get("solidReference") == "full-title-v2", "expected full-title Solid")
    zip_path = build / (name + ".zip")
    zip_sha = digest(zip_path)
    require(zip_sha == read_json(build / "zips.json")[name]["sha256"], "prepared ZIP receipt mismatch")
    require(digest(build / "runtime.tgz") == inputs["archiveSha256"], "package receipt mismatch")
    require(inputs["fixtureSha256"] == digest(HERE.parent / "shelf/shared/shelf.ts"),
            "shared catalog has changed since collection")
    with ZipFile(zip_path) as archive:
        font = "fonts/font-0.ttf" if renderer == "react" else "fonts/Inter_400Regular.ttf"
        require(sha256(archive.read(font)).hexdigest() == inputs["fontSha256"],
                "packaged font differs from fixture receipt")
    # Rebuild the observer ZIP from the timed bytes. Marked runs supply native field
    # semantics. Their timestamps are never pooled with the ordinary launches.
    with TemporaryDirectory() as temp:
        probe = Path(temp) / "probe.zip"
        subprocess.run([sys.executable, str(HERE / "probe.py"), str(zip_path), str(probe), renderer],
                       check=True)
        marked_sha = digest(probe)
    marked_trace = verify_trace(marked, processor)
    verified = measure(marked, marked=True)
    config = configuration(read_json(marked / "replay/summary.json"), renderer, marked_sha, route)
    return ({"zipSha256": zip_sha, "markedZipSha256": marked_sha,
             "markedTraceSha256": marked_trace, "verifiedFieldMoves": len(verified["samples"])},
            config, inputs, verified["samples"])


def balanced(blocks):
    orders = [tuple(b["order"]) for b in blocks]
    a, b = ("control", "candidate"), ("candidate", "control")
    require(len(orders) >= 4 and orders.count(a) == orders.count(b)
            and orders.count(a) + orders.count(b) == len(orders),
            "use at least two fresh pairs per order and equal numbers in both orders")


def scorecard(manifest, react_build, solid_build, react_fields, solid_fields, processor):
    spec = read_json(manifest)
    balanced(spec["blocks"])
    route = frozen_route()
    builds, attributions = {}, {}
    config = None
    shared = None
    for renderer, build, fields in (("react", react_build, react_fields),
                                    ("solid", solid_build, solid_fields)):
        info, device, inputs, proof = fixture(build, fields, renderer, route, processor)
        common = {k: inputs[k] for k in ("sdk", "fontSha256", "fixtureSha256")}
        require(shared in (None, common) and config in (None, device),
                "different fixture, font, SDK or marked device configuration")
        config, shared = device, common
        builds[renderer] = info
        attributions[info["zipSha256"]] = proof
        info["requiredApplyOrdinals"] = [row["requiredApplyOrdinal"] for row in proof]
        info["nativeApplyCounts"] = [row["nativeApplies"] for row in proof]
        if renderer == "react":
            info["packageSha256"] = inputs["archiveSha256"]
    result = compare(manifest, post_apply=True, attributions=attributions)
    require(not result["identicalArtifacts"], "expected different framework ZIPs")
    roles, traces, launches = {}, set(), []
    previous = None
    for i, launch in enumerate(result["launches"]):
        path = Path(launch["path"])
        replay = read_json(path / "replay/summary.json")
        renderer = replay["mode"]
        require(renderer in builds, "unknown framework")
        require(roles.setdefault(launch["role"], renderer) == renderer, "framework changed roles")
        require(configuration(replay, renderer, builds[renderer]["zipSha256"], route) == config,
                "changed device configuration or pacing between timing and field runs")
        timestamp = datetime.fromisoformat(replay["clock"]["utcAtStart"].replace("Z", "+00:00"))
        require(timestamp.utcoffset() is not None and (previous is None or previous < timestamp),
                "declared launch order disagrees with collection timestamps")
        previous = timestamp
        verify_settled(path, route)
        trace = verify_trace(path, processor)
        require(trace not in traces, "reused trace")
        traces.add(trace)
        # Retain all timed steps so readers can independently recalculate the published statistics.
        launches.append({"postApplySwapMs": launch["postApplySwapMs"], "pair": i // 2 + 1, "renderer": renderer, "traceSha256": trace,
                         "metricsMs": {s: launch["metricsMs"][s][ENDPOINT] for s in STRATA}})
    require(set(roles.values()) == set(builds), "expected both React and Solid")
    pairs = []
    for i, block in enumerate(result["blocks"]):
        pair = {l["renderer"]: l["metricsMs"] for l in launches[2*i:2*i+2]}
        sign = 1 if roles["control"] == "react" else -1
        pairs.append({"order": [roles[r] for r in block["order"]],
                      "reactMinusSolidMs": {s: {
                          "matchedMedian": sign * block["matchedMedianSavedMs"][s][ENDPOINT],
                          "launchP95Difference": pair["react"][s]["p95"] - pair["solid"][s]["p95"]
                      } for s in STRATA}})
    noise = {name: {s: max(n["medianAbsMatchedMs"][s][ENDPOINT]
                           for n in result["sameBuildMatchedNoise"] if n["role"] == role)
                    for s in STRATA} for role, name in roles.items()}
    return {"schemaVersion": 1, "workload": "Frozen 24-card full-title shelf",
            "endpoint": "Device key-down to completed SDK swap of a render begun after the required native updates",
            **config, **shared, "route": route["schedule"], "processorSha256": digest(processor), "builds": builds, "launches": launches, "pairs": pairs,
            "scoredInputs": sum(l["metricsMs"]["overall"]["n"] for l in launches),
            "excludedAttempts": len(result["excludedAttempts"]),
            "maxSameBuildMedianAbsoluteMatchedMs": noise,
            "imageHoldout": "separate workload", "firstVisibleHighlight": "UNMEASURED"}


def markdown(r):
    d = r["device"]
    out = ["# React Native and Solid on the frozen Roku shelf", "",
           f"Roku {d['model']}, firmware {d['firmware']} build {d['firmwareBuild']}, "
           f"{d['uiResolution']} UI. SDK {r['sdk']}. Input spacing setting {r['spacingMs']} ms.", "",
           r["endpoint"] + ". The independent marked runs check both highlights, the full title, "
           "native focus and scroll position.", "",
           f"{r['scoredInputs']} inputs scored across {len(r['launches'])} fresh launches. "
           f"Excluded attempts listed in the manifest: {r['excludedAttempts']}. "
           "Every scored move had a matching settled native tree.", "",
           "| Pair | Framework | Moves | Median (ms) | p95 | Worst | Stationary median | Scrolling median |",
           "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for l in r["launches"]:
        m = l["metricsMs"]
        a = m["overall"]
        out.append(f"| {l['pair']} | {l['renderer']} | {a['n']} | {a['median']:.2f} | {a['p95']:.2f} | "
                   f"{a['worst']:.2f} | {m['nonScrolling']['median']:.2f} | {m['scrolling']['median']:.2f} |")
    out.extend(["", "Positive gaps mean React took longer. Median gaps compare matched moves. "
                "The p95 gap compares the two launch percentiles.", "",
                "| Pair | Launch order | Median gap (ms) | p95 gap (ms) |",
                "| ---: | --- | ---: | ---: |"])
    for i, pair in enumerate(r["pairs"], 1):
        gap = pair["reactMinusSolidMs"]["overall"]
        out.append(f"| {i} | {' then '.join(pair['order'])} | {gap['matchedMedian']:.2f} | "
                   f"{gap['launchP95Difference']:.2f} |")
    n = r["maxSameBuildMedianAbsoluteMatchedMs"]
    out.extend(["", f"Largest same-build median absolute matched difference: React {n['react']['overall']:.2f} ms, "
                f"Solid {n['solid']['overall']:.2f} ms. Launches are the repeat unit.", "",
                "First visible highlight and compositor pixels are unmeasured. The image-backed holdout, "
                "sustained input, memory and other Roku models require separate results.", "",
                f"React package SHA-256 `{r['builds']['react']['packageSha256']}`", ""])
    for framework, b in r["builds"].items():
        out.extend([f"{framework.capitalize()} ZIP SHA-256 `{b['zipSha256']}`", ""])
    return "\n".join(out)
