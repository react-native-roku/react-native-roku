import csv
import json
import math
import statistics
import sys
from pathlib import Path

path = Path(sys.argv[1])
summary = json.loads((path / "replay/summary.json").read_text())
assert summary["pass"] and summary["cohort"] == "trace"
expected = summary["warmup"] + summary["schedule"]
with (path / "timeline.csv").open() as table:
    rows = list(csv.DictReader(table))
down = [i for i, row in enumerate(rows) if row["event"] == "keyEvent" and row["press"] == "1"]
assert len(down) >= len(expected)
# The recorder includes buffered events from the preceding warm run. Locate
# the live run by its matching warmup + directional prefix. Skip missing tail
# observations instead of filling them from the buffered cohort.
sequence = [rows[index]["key"] for index in down]
directions = [step["key"].lower() for step in expected]
matches = [i for i in range(len(sequence)) if 10 <= len(sequence) - i <= len(directions)
           and sequence[i:] == directions[:len(sequence) - i]]
assert matches, f"No matching final live sequence in {sequence}"
down = down[matches[0]:]
observations = []
for number, (start, end, step) in enumerate(zip(down, down[1:] + [len(rows)], expected)):
    key = rows[start]
    assert key["key"] == step["key"].lower()
    offset = int(key["device_ts_ns"])
    window = [r for r in rows[start + 1:end] if int(r["device_ts_ns"]) - offset < 200_000_000]
    releases = [r for r in window if r["event"] == "keyEvent" and r["press"] == "0"]
    assert len(releases) == 1 and releases[0]["key"] == key["key"]
    if number < len(summary["warmup"]):
        continue
    def events(name, track=None):
        return [r for r in window if r["event"] == name and (track is None or r["track"] == track)]
    def relative(row, complete=False):
        return (int(row["device_ts_ns"]) - offset + (max(0, int(row["duration_ns"])) if complete else 0)) / 1e6
    dispatch = events("transaction.toTS.commit", "RenderThr:Main")
    starts = events("transaction.start", "ts_event_dev")
    commits = events("transaction.commit", "ts_event_dev")
    renders = events("render", "RenderThr:Main")
    swaps = events("swapBuffers", "RenderThr:Main")
    observations.append({
        **step, "deviceKeyMs": offset / 1e6,
        "keyToReleaseMs": relative(releases[0]),
        "keyToSdkDispatchMs": relative(dispatch[0]) if dispatch else None,
        "keyToFirstTsStartMs": relative(starts[0]) if starts else None,
        "keyToFirstTsCommitMs": relative(commits[0]) if commits else None,
        "keyToLastTsStartMs": relative(starts[-1]) if starts else None,
        "keyToLastTsCommitMs": relative(commits[-1]) if commits else None,
        "keyToRenderMs": relative(renders[0]) if renders else None,
        "keyToSwapCompleteMs": relative(swaps[0], complete=True) if swaps else None,
        "tsStarts": len(starts), "tsCommits": len(commits), "renders": len(renders),
    })
def describe(metric):
    vals = sorted(r[metric] for r in observations if r[metric] is not None)
    return dict(count=len(vals), medianMs=statistics.median(vals), p95Ms=vals[math.ceil(.95 * len(vals)) - 1], worstMs=vals[-1]) if vals else None
metrics = {metric: describe(metric) for metric in observations[0] if metric.startswith("keyTo")}
print(json.dumps(dict(deviceClock="Perfetto trace device clock", windowMs=200, missingTailMoves=len(expected) - len(down), metrics=metrics, samples=observations), indent=2))
