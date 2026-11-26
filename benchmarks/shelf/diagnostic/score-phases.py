"""Score contiguous React/renderer phases from matched shelf trace moves."""
import json
import statistics
import sys

moves = json.load(open(sys.argv[1]))["moves"]
assert len(moves) == 30
boundaries = [
    ("nativeFocusToJsDelivery", "native", "focus.delivery"),
    ("deliveryToEventStart", "focus.delivery", "react.event.start"),
    ("reactEvent", "react.event.start", "react.event.end"),
    ("reactRenderAndScheduling", "react.event.end", "react.mutations.start"),
    ("reactScheduleToAppRender", "react.event.end", "react.render"),
    ("reactRenderToHostCommit", "react.render", "react.mutations.start"),
    ("reactHostCommit", "react.mutations.start", "react.mutations.end"),
    ("rendererCommitSetup", "react.mutations.end", "layout.input.start"),
    ("layoutInputConstruction", "layout.input.start", "layout.input.end"),
    ("layoutComparison", "layout.compare.start", "layout.compare.end"),
    ("geometrySetup", "layout.compare.end", "layout.validate.start"),
    ("preparedFieldValidation", "layout.validate.start", "layout.validate.end"),
    ("placementSnapshotSetup", "layout.validate.end", "layout.snapshot.end"),
    ("placementWalk", "layout.snapshot.end", "layout.placements.end"),
]
samples = []
for move in moves:
    matching = f"shelf-{move['to']}"
    events = move["events"]
    native = next(row for row in events if row.get("nativeCard") == matching)
    relevant = [row for row in events if row["ts"] >= native["ts"]]
    names = dict(native=native["ts"])
    delivery = next(row for row in relevant
                    if row.get("event") == "focus.delivery" and row.get("card") == matching)
    for row in relevant:
        if row["ts"] >= delivery["ts"] and row.get("input") == delivery["input"]:
            names.setdefault(row.get("event"), row["ts"])
    assert names["react.event.end"] <= names["react.render"] <= names["react.mutations.start"]
    phases = {name: (names[end] - names[start]) / 1e6 for name, start, end in boundaries}
    phases["observedFocusToLayoutPreparation"] = (
        names["layout.input.start"] - names["focus.delivery"]
    ) / 1e6
    phases["geometryAndValidation"] = (names["layout.snapshot.end"] - names["layout.compare.end"]) / 1e6
    assert min(phases.values()) >= 0, (move["key"], matching, phases)
    samples.append(dict(key=move["key"], to=matching, phasesMs=phases))

summary = {}
for phase in samples[0]["phasesMs"]:
    values = sorted(s["phasesMs"][phase] for s in samples)
    summary[phase] = dict(count=len(values), medianMs=statistics.median(values),
                          p95Ms=values[28], worstMs=values[-1])
print(json.dumps(dict(summary=summary, samples=samples), indent=2))
