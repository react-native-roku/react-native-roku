"""Qualify the row-window swap separately from the indicator fade and first swap."""
import argparse
from collections import defaultdict
from math import ceil
import json
from pathlib import Path
from statistics import median
import sys

here = Path(__file__).resolve().parent
sys.path.insert(0, str(here.parent))
from burst import check, end, epochs, frames, read_csv, read_json, start, trace_clean

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("run", type=Path)
role = parser.add_mutually_exclusive_group(required=True)
role.add_argument("--marked-zip-proof", type=Path)
role.add_argument("--attribution", type=Path)
args = parser.parse_args()
path = args.run
trace_clean(path / "trace-stats.csv")
replay = read_json(path / "replay/summary.json")
check(replay["pass"], "native replay failed")
steps = replay["steps"]
expected = ["right"] * 2 + ["down"] * 7 + ["up"] * 4 + ["select", "back"] + ["up"] * 3 + ["left"] * 2
check([step["key"].lower() for step in steps] == expected, "unexpected frozen release replay route")
rows = read_csv(path / "attribution.csv")
keys = [row for row in rows if row["name"] == "keyEvent" and row["press"] == "1"]
observed = [row["key"].lower() for row in keys]
observed = ["select" if key in ("ok", "enter") else key for key in observed]
check(observed == expected, "unexpected or missing device key-downs")
pairs = frames(rows)
marks = []
attributed = {}
if args.marked_zip_proof:
    proof = read_json(args.marked_zip_proof)
    check(proof["markedZipSha256"] == replay["sha256"]
          and proof["changed"] == ["components/HelloRokuScene.brs"], "wrong marked ZIP")
    origin = proof["exactZipSha256"]
    marks = epochs(rows, read_json(path / "native-probe.json"), scenario="Deep")
else:
    proof = read_json(args.attribution)
    check(proof["originZipSha256"] == replay["sha256"]
          and proof["basis"] == "marked native spacer, scroll and indicator", "wrong exact ZIP proof")
    origin = replay["sha256"]
    attributed = {item["move"]: item for item in proof["samples"]}

updates, tails = defaultdict(list), defaultdict(list)
commits = []
for row in rows:
    if row["name"] == "transaction.commit" and row["track"] == "ts_event_dev":
        commits.append(row)
    elif row["name"] == "transaction.update":
        updates[row["flow_from"]].append(row)
    elif row["name"] == "transaction.end":
        tails[row["flow_from"]].append(row)

def observed_focus(value, step):
    return (value["focus"] == [step["id"]]
            and value["position"] == f'{step["id"] + 1} of 72'
            and value["offset"] == step["offset"]
            and value["clip"] == {"x": 0, "y": 0, "width": 1560, "height": 680}
            and value["color"] & 0xffffffff == 0x3456c0ff)

samples = []
for index, step in enumerate(steps[:-1]):
    move = index + 1
    zero, limit = start(keys[index]), start(keys[index + 1])
    check(limit - zero > 850e6, f"overlapping input window {move}")
    applies = []
    for submit in (row for row in commits if zero <= start(row) < limit):
        applied = updates[submit["id"]]
        check(len(applied) == 1, f"unlinked submission at {move}")
        tail = tails[applied[0]["id"]]
        check(len(tail) == 1 and start(submit) <= end(tail[0]) < limit,
              f"unlinked or late apply at {move}")
        applies.append(end(tail[0]))
    check(applies and applies == sorted(applies), f"no ordered apply at {move}")
    first = next((swap for render, swap in pairs if zero <= render <= swap < limit), None)
    final = next((swap for render, swap in pairs if applies[-1] <= render <= swap < limit), None)
    sample = {**step, "move": move,
              "windowMs": (limit - zero) / 1e6,
              "lastSwapMs": (final - zero) / 1e6 if final else None,
              "firstSwapMs": (first - zero) / 1e6 if first else None,
              "nativeApplyMs": [(apply - zero) / 1e6 for apply in applies]}
    if index in (4, 5, 6, 7, 8, 11, 12):
        check(step["phase"] in ("down", "reverse") and (step["enters"] or step["leaves"]),
              f"missing structural scroll at {move}")
        if marks:
            snapshots = [(applies.index(b) + 1, obs["kind"], obs["value"])
                         for a, b, fields in marks if zero <= a <= b < limit and b in applies
                         for obs in fields]
            spacer = [(ordinal, value) for ordinal, kind, value in snapshots
                      if kind == "spacer" and observed_focus(value, step)
                      and value["spacer"] == (max(step["rows"]) + 1) * 200
                      and value["indicator"] == 1]
            visible = [(ordinal, value) for ordinal, kind, value in snapshots
                       if kind == "indicator" and observed_focus(value, step)
                       and value["indicator"] == 1]
            fade = [(ordinal, value) for ordinal, kind, value in snapshots
                    if kind == "indicator" and observed_focus(value, step)
                    and value["indicator"] == 0 and value["rows"] == step["rows"]]
            check(len(spacer) == len(fade) == len(visible) == 1, f"unproved row window or fade at {move}")
            ordinal, state = spacer[0]
            fade_ordinal, fade_state = fade[0]
            visible_ordinal, visible_state = visible[0]
            check(visible_ordinal < ordinal and ordinal + 1 == fade_ordinal == len(applies)
                  and visible_state["visible"] == state["visible"] == fade_state["visible"], f"wrong apply ordering at {move}")
            sample["visibleObservation"] = visible_state
            sample["spacerObservation"] = state
            sample["fadeObservation"] = fade_state
        else:
            marked = attributed[move]
            check(marked["id"] == step["id"] and marked["rows"] == step["rows"]
                  and marked["offset"] == step["offset"]
                  and len(marked["nativeApplyMs"]) == len(applies),
                  f"marked and exact phases differ at {move}")
            ordinal, fade_ordinal = marked["windowApplyOrdinal"], marked["fadeApplyOrdinal"]
            visible_ordinal = marked["visibleApplyOrdinal"]
            check(1 <= visible_ordinal < ordinal < fade_ordinal == len(applies), f"invalid field-proof ordering at {move}")
        visible_swap = next((s for r, s in pairs if applies[visible_ordinal - 1] <= r <= s < applies[ordinal - 1]), None)
        window_swap = next((s for r, s in pairs if applies[ordinal - 1] <= r <= s < applies[fade_ordinal - 1]), None)
        check(first and visible_swap and window_swap and final, f"missing completed row-window or fade swap at {move}")
        sample.update({"visibleApplyOrdinal": visible_ordinal, "visibleSwapMs": (visible_swap - zero) / 1e6,
                       "windowApplyOrdinal": ordinal, "fadeApplyOrdinal": fade_ordinal,
                       "windowSwapMs": (window_swap - zero) / 1e6})
    samples.append(sample)

def stats(selected, key):
    values = [s[key] for s in selected]
    valid = sorted(value for value in values if value is not None)
    unmeasured = len(values) - len(valid)
    if not valid:
        return {"n": 0, "unmeasured": unmeasured}
    values = valid
    return {"n": len(values), "unmeasured": unmeasured, "medianMs": median(values),
            "p95Ms": values[ceil(len(values) * .95) - 1], "maxMs": values[-1]}

print(json.dumps({
    "basis": "marked native spacer, scroll and indicator" if marks else "exact SDK flows with matched marked proof",
    "sha256": replay["sha256"],
    "originZipSha256": origin,
    "endpoint": "device key-down to the first completed swap after the verified mounted-window apply and before the separate indicator fade",
    "window": stats((s for s in samples if "windowSwapMs" in s), "windowSwapMs"),
    "windowDown": stats((s for s in samples if "windowSwapMs" in s and s["phase"] == "down"), "windowSwapMs"),
    "windowReverse": stats((s for s in samples if "windowSwapMs" in s and s["phase"] == "reverse"), "windowSwapMs"),
    "windowVisibleSwap": stats((s for s in samples if "windowSwapMs" in s), "visibleSwapMs"),
    "windowFirstSwap": stats((s for s in samples if "windowSwapMs" in s), "firstSwapMs"),
    "windowLastSwapWithFade": stats((s for s in samples if "windowSwapMs" in s), "lastSwapMs"),
    "reverse": stats((s for s in samples if s["phase"] == "reverse"), "lastSwapMs"),
    "select": stats((s for s in samples if s["phase"] == "open"), "lastSwapMs"),
    "back": stats((s for s in samples if s["phase"] == "return"), "lastSwapMs"),
    "backHostObserved": stats((s for s in samples if s["phase"] == "return"), "observedHostMs"),
    "samples": samples,
}, indent=2))
