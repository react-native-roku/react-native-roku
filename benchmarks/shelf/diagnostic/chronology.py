"""Correlate the captured native, SDK and shelf markers on the Perfetto clock."""
import csv
import json
import statistics
import sys
from pathlib import Path

root = Path(sys.argv[1])
summary = json.loads((root / "replay/summary.json").read_text())
with (root / "timeline.csv").open() as source:
    rows = [{k: v for k, v in row.items() if v != "[NULL]"} for row in csv.DictReader(source)]
for row in rows:
    row["ts"] = int(row["ts"])
mark_rows = [row for row in rows if row.get("jsMs")]
offsets = [row["ts"] / 1e6 - float(row["jsMs"]) for row in mark_rows]
offset = statistics.median(offsets) if offsets else None
alignment = {
    "samples": len(offsets),
    "medianOffsetMs": offset,
    "maxResidualMs": max(abs(value - offset) for value in offsets) if offsets else None,
}

key_alias = {"OK": "Select", "enter": "Select"}
def key_name(row):
    key = row["key"]
    return key_alias.get(key, key.title())

def native_edge(row):
    return row["name"] == "keyEvent" and "key" in row

downs = [index for index, row in enumerate(rows) if native_edge(row) and row["press"] == "1"]
actual = [key_name(rows[i]) for i in downs]

def match_suffix(expected, allow_missing=0):
    for first in range(max(0, len(actual) - len(expected)), len(actual)):
        end = actual[first:]
        if len(end) >= len(expected) - allow_missing and end == expected[:len(end)]:
            return downs[first:]
    return []

def elapsed(row, start):
    return (row["ts"] - start) / 1e6

def window(start, end):
    origin = rows[start]["ts"]
    return [dict(row, relativeMs=elapsed(row, origin)) for row in rows[start:end]]

def event(row, name):
    return row.get("event") == name

if summary["cohort"] == "burst":
    names = [item["name"] for item in summary.get("bursts", [])]
    burst_keys = ["Right", "Right", "Right", "Left", "Select"]
    expected = [key for index, _ in enumerate(names)
                for key in (["Left", "Left"] if index else []) + burst_keys]
    indices = match_suffix(expected)
    trials = []
    if indices:
        for i, name in enumerate(names):
            start = 7 * i
            end = indices[start+5] if start+5 < len(indices) else len(rows)
            events = window(indices[start], end)
            edges = [{"key": key_name(row), "phase": "down" if row["press"] == "1" else "up",
                      "deviceMs": row["relativeMs"]} for row in events if native_edge(row)]
            trials.append({
                "name": name, "edges": edges,
                "nativeFocus": [row["nativeCard"] for row in events if row.get("nativeCard")],
                "reactFocus": [row.get("target") for row in events if event(row, "react.focus.callback")],
                "sdkFocus": [row.get("card") for row in events if event(row, "focus.delivery")],
                "activation": [row.get("target") for row in events if event(row, "press.handler")],
                "selectFences": [row for row in events if event(row, "select.fenced")],
                "events": events,
            })
    print(json.dumps({
        "fixture": summary["mode"], "clockAlignment": alignment,
        "nativeDowns": actual, "expectedDowns": expected,
        "missingTrials": len(names) - len(trials), "trials": trials,
    }, indent=2))
else:
    expected = summary["warmup"] + summary["schedule"]
    indices = match_suffix([step["key"] for step in expected], allow_missing=2)
    moves = []
    landmarks = ["focus.request", "focus.delivery", "focus.enqueue", "focus.execute",
                 "focus.state.schedule", "react.focus.callback", "react.render", "react.commit",
                 "layout.input.start", "layout.input.end", "layout.compare.start",
                 "layout.compare.end", "layout.geometry.end", "layout.snapshot.end",
                 "layout.placements.end", "fields.apply", "fields.done"]
    for number, start in enumerate(indices):
        if number < len(summary["warmup"]):
            continue
        end = indices[number+1] if number+1 < len(indices) else len(rows)
        step = expected[number]
        events = window(start, end)
        boundaries = {
            name: next((row["relativeMs"] for row in events if event(row, name)), None)
            for name in landmarks
        }
        for name, predicate in (
            ("nativeFocus", lambda row: "nativeCard" in row),
            ("newHighlight", lambda row: event(row, "field.submit") and row.get("field") == "color"
             and row.get("node") == f"shelf-{step['to']}"),
            ("oldHighlight", lambda row: event(row, "field.submit") and row.get("field") == "color"
             and row.get("node") == f"shelf-{step['from']}"),
            ("title", lambda row: event(row, "field.submit") and row.get("node") == "selection"),
            ("render", lambda row: row["name"] == "render" and row.get("track") == "RenderThr:Main"),
            ("swap", lambda row: row["name"] == "swapBuffers" and row.get("track") == "RenderThr:Main"),
        ):
            boundaries[name] = next((row["relativeMs"] for row in events if predicate(row)), None)
        moves.append({**step, "millisecondsFromDeviceDown": boundaries, "events": events})
    print(json.dumps({
        "clockAlignment": alignment, "nativeDowns": actual,
        "missingMoves": len(expected) - len(indices), "moves": moves,
    }, indent=2))
