"""Match SDK transaction flows to completed renders for paced catalog moves."""

from collections import defaultdict

from burst import check, end, epochs, frames, read_csv, read_json, start, trace_clean, update
from catalog import expected, native_snapshot, offset_for, verify_snapshot


def linked_moves(samples, rows):
    commits = [r for r in rows if r["name"] == "transaction.commit" and r["track"] == "ts_event_dev"]
    updates = defaultdict(list)
    completions = defaultdict(list)
    for row in rows:
        if row["name"] == "transaction.update":
            updates[row["flow_from"]].append(row)
        elif row["name"] == "transaction.end":
            completions[row["flow_from"]].append(row)
    pairs = frames(rows)
    movements = []
    for sample in samples:
        zero = round(sample["deviceKeyMs"] * 1e6)
        deadline = zero + 200_000_000
        submits = [row for row in commits if zero <= start(row) < deadline]
        check(submits, "paced move has no SDK submission")
        applies = []
        for submit in submits:
            update_rows = updates[submit["id"]]
            check(len(update_rows) == 1, "ambiguous SDK update")
            native_update = update_rows[0]
            tails = completions[native_update["id"]]
            check(len(tails) == 1 and tails[0]["apply_id"] == native_update["apply_id"]
                  and native_update["apply_id"] != "[NULL]", "ambiguous SDK apply completion")
            a, b = start(native_update), end(tails[0])
            check(start(submit) <= a <= b < deadline, "SDK apply outside the move window")
            applies.append((a, b))
        check(all(a[1] <= b[0] for a, b in zip(applies, applies[1:])),
              "SDK applies overlap or arrive out of order")
        candidates = [(r, s) for r, s in pairs if zero <= r <= s < deadline]
        check(candidates, "missing completed frame")
        first = candidates[0][1]
        check(abs((first - zero) / 1e6 - sample["keyToSwapCompleteMs"]) < 0.001,
              "independent first swap scorers disagree")
        movements.append((zero, deadline, applies, first, candidates))
    return movements


def post_apply_frame(applies, ordinal, candidates):
    needed = applies[ordinal - 1][1]
    match = next((frame for frame in candidates if needed <= frame[0]), None)
    check(match is not None, "missing post-apply frame")
    return match


def observed_ordinal(applies, relevant, state, target):
    by_apply = {(a, b): fields for a, b, fields in relevant}
    check(set(by_apply).issubset(applies), "field observer outside a linked SDK apply")
    observed_focus = []
    complete_since = None
    for ordinal, apply in enumerate(applies, 1):
        for field in by_apply.get(apply, []):
            update(state, field)
            if field["kind"] == "focus":
                observed_focus.append(field["index"])
        if all(state.get(k) == v for k, v in target.items()):
            if complete_since is None:
                complete_since = ordinal
        else:
            complete_since = None
    check(observed_focus == [target["focus"]] and complete_since is not None,
          "native updates failed to carry the required state")
    return complete_since


def measure(path, marked=False, attribution=None):
    check(not (marked and attribution is not None), "choose marked or ordinary attribution")
    trace_clean(path / "trace-stats.csv")
    rows = read_csv(path / "attribution.csv")
    summary = read_json(path / "device-summary.json")
    replay = read_json(path / "replay/summary.json")
    samples = summary["samples"]
    check(replay["pass"] and replay["cohort"] == "trace" and not summary["missingTailMoves"]
          and len(samples) == len(replay["schedule"]) > 0, "incomplete paced replay")
    moves = linked_moves(samples, rows)
    if attribution is not None:
        check(len(attribution) == len(samples), "missing marked move")
    offset = 0
    for step in replay["warmup"]:
        offset = offset_for(step["to"], offset)
    if marked:
        seed = native_snapshot(read_json(path / "replay/step-01.json")["before"]["xml"])
        check(verify_snapshot(seed, samples[0]["from"], offset), "initial state mismatch")
        state = dict(seed, lines=expected(samples[0]["from"], offset)["lines"], wrap=True)
        groups = epochs(rows, read_json(path / "native-probe.json"), (moves[0][0], moves[-1][1]))
        check(any(b <= moves[0][0] for _, b, _ in groups), "field observers absent during warmup")

    data = []
    for i, (sample, (zero, deadline, applies, first, candidates)) in enumerate(zip(samples, moves)):
        offset = offset_for(sample["to"], offset)
        if marked:
            relevant = [(a, b, fields) for a, b, fields in groups if zero <= a < deadline]
            ordinal = observed_ordinal(applies, relevant, state, dict(expected(sample["to"], offset), wrap=True))
        elif attribution is not None:
            proof = attribution[i]
            check(all(proof[k] == sample[k] for k in ("key", "from", "to"))
                  and proof["nativeApplies"] == len(applies), "apply sequence differs from the marked move")
            ordinal = proof["requiredApplyOrdinal"]
            check(1 <= ordinal <= len(applies), "invalid required apply")
        else:
            # Historical CLI comparisons explicitly score the second of two linked applies.
            check(len(applies) == 2, "paced move does not match the two-apply field attribution")
            ordinal = 2
        after = post_apply_frame(applies, ordinal, candidates)
        data.append(dict(sample, nativeApplies=len(applies), requiredApplyOrdinal=ordinal,
                         keyToPostApplySwapMs=(after[1] - zero) / 1e6,
                         keyToPostApplyRenderMs=(after[0] - zero) / 1e6,
                         keyToRequiredApplyEndMs=(applies[ordinal-1][1] - zero) / 1e6,
                         keyToSecondApplyEndMs=(applies[1][1] - zero) / 1e6 if len(applies) >= 2 else None,
                         firstSwapBeforeSecondApply=first < applies[1][0] if len(applies) >= 2 else None))
    return {"sha256": replay["artifact"]["sha256"], "samples": data,
            "attribution": ("native fields and SDK flow" if marked else "matched marked apply ordinal"
                            if attribution is not None else "SDK flow with two linked applies"),
            "firstVisibleHighlight": "UNMEASURED"}
