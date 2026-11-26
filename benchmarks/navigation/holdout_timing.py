"""Device-clock timing for the seven paced Down inputs in the independent holdout."""

from burst import check, end, epochs, frames, read_csv, read_json, start, trace_clean


def complete_state(snapshot, destination):
    offset = max(0, (destination - 3) * 96)
    if snapshot["focus"] != destination or snapshot["offset"] != offset:
        return False
    for index in range(offset // 96 + 1, offset // 96 + 4):
        title = ("Long ridge walk past the lakes and back to the valley"
                 if index % 3 == 2 else "Valley walk")
        expected = {
            "y": (index - 1) * 96,
            "color": 0x3456C0FF if index == destination else 0x303040FF,
            "title": f"Route {index} — {title}",
            "titlewidth": 600,
            "posterwidth": 96,
            "posterheight": 96,
        }
        row = snapshot["rows"].get(f"route-{index}")
        if not row or not row["poster"].startswith("pkg:/images/"):
            return False
        actual = dict(row, color=row["color"] & 0xffffffff, title=" ".join(row["title"].split()))
        if any(actual[k] != v for k, v in expected.items()):
            return False
    return True


def measure_holdout(path, marked=False, attribution=None):
    check(not (marked and attribution), "choose directly marked or separately attributed evidence")
    attributed = read_json(attribution)["samples"] if attribution else None
    trace_clean(path / "trace-stats.csv")
    replay = read_json(path / "replay/summary.json")
    check(replay["pass"] and replay["timed"], "missing passing paced holdout replay")
    steps = replay["steps"]
    check(all(step["pass"] for step in steps), "failed native holdout state")
    requested = [s["key"].lower() for s in steps if s["key"]]
    check(requested == ["down"] * 7 + ["select", "select", "back", "select", "down",
                                        "select", "select", "back"], "unexpected holdout route")
    rows = read_csv(path / "attribution.csv")
    downs = [r for r in rows if r["name"] == "keyEvent" and r["press"] == "1"]
    keys = ["select" if r["key"] in ("OK", "ok", "enter") else r["key"].lower() for r in downs]
    matches = [i for i in range(len(keys) - len(requested) + 1)
               if keys[i:i + len(requested)] == requested]
    check(len(matches) == 1, "cannot align holdout keys to the complete replay")
    down = [start(r) for r in downs[matches[0]:matches[0] + 8]]
    pairs = frames(rows)
    groups = (epochs(rows, read_json(path / "native-probe.json"), (down[0], down[-1]),
                     scenario="Holdout") if marked else [])
    results = []
    for i, (zero, limit) in enumerate(zip(down, down[1:])):
        check(limit - zero >= 200_000_000, "holdout timing windows overlap")
        submits = [r for r in rows if r["name"] == "transaction.commit" and
                   r["track"] == "ts_event_dev" and zero <= start(r) < limit]
        check(submits, "missing holdout SDK submission")
        required = set(r["id"] for r in submits)
        applies = [r for r in rows if r["name"] == "transaction.update" and
                   r["flow_from"] in required]
        check(len(applies) == len(required) and {r["flow_from"] for r in applies} == required,
              "unmatched holdout submission")
        applied = set(r["id"] for r in applies)
        tails = [r for r in rows if r["name"] == "transaction.end" and r["flow_from"] in applied]
        check(len(tails) == len(applied) and {r["flow_from"] for r in tails} == applied,
              "unmatched holdout apply")
        tails.sort(key=start)
        required_apply = None
        if marked:
            for a, b, fields in groups:
                if not zero <= a <= b < limit or not complete_state(fields[-1]["value"], i + 2):
                    continue
                required_apply = next((j + 1 for j, tail in enumerate(tails) if end(tail) == b), None)
                if required_apply:
                    break
            check(required_apply, f"missing complete visible state for Holdout Route {i + 2}")
        elif attributed:
            observation = attributed[i]
            check(observation["route"] == steps[i + 1]["id"]
                  and observation["nativeApplies"] == len(tails),
                  f"holdout apply sequence differs for Route {i + 2}")
            required_apply = observation["requiredApplyOrdinal"]
            check(1 <= required_apply <= len(tails), "missing marked holdout apply ordinal")
        latest = end(tails[-1])
        needed = end(tails[required_apply - 1]) if required_apply else latest
        first = next((s for r, s in pairs if zero <= r <= s < limit), None)
        post = next((s for r, s in pairs if needed <= r <= s < limit), None)
        check(first is not None and post is not None, "missing completed holdout render")
        results.append({"route": steps[i + 1]["id"],
                        "scrolling": steps[i + 1]["card"]["y"] <= steps[i]["card"]["y"],
                        "keyToFirstSwapMs": (first - zero) / 1e6,
                        "requiredApplyOrdinal": required_apply,
                        "keyToRequiredApplyMs": (needed - zero) / 1e6 if required_apply else None,
                        "keyToLastApplyMs": (latest - zero) / 1e6,
                        "keyToPostApplySwapMs": (post - zero) / 1e6,
                        "nativeApplies": len(tails)})
    return {"sha256": replay["sha256"], "samples": results,
            "basis": ("native visible row state and SDK flow" if marked else
                      "SDK flow with separate marked attribution" if attributed else
                      "SDK sequence and independent settled replay; native field attribution pending"),
            "firstVisibleHighlight": "UNMEASURED"}
