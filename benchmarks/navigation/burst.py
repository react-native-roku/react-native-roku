"""Score a catalog burst using native observations on the Perfetto clock."""
import csv
import json
from collections import defaultdict
from xml.etree.ElementTree import ParseError

from catalog import expected, validate_replay, verify_burst_route


class Unmeasured(ValueError):
    """The capture cannot support this observation."""


def check(condition, reason):
    if not condition:
        raise Unmeasured(reason)


def read_json(path):
    with path.open() as stream:
        return json.load(stream)


def read_csv(path):
    with path.open(newline="") as stream:
        return list(csv.DictReader(stream))


def trace_clean(path):
    with path.open(newline="") as stream:
        rows = csv.DictReader(stream)
        check(rows.fieldnames == ["name", "idx", "severity", "value"], "missing trace quality header")
        check(not list(rows), "trace loss or recorder errors reported")


def start(row):
    return int(row["ts"])


def end(row):
    duration = int(row["dur"])
    check(duration >= 0, "incomplete trace slice")
    return start(row) + duration


def epochs(rows, probe, window=None, scenario="Catalog"):
    check(probe["available"] and not probe["droppedLines"], "missing or truncated console")
    fields = [json.loads(s.partition("|")[2]) for s in probe["lines"]
              if s.startswith("RNR_" + scenario.upper() + "_FIELD|")]
    callbacks = [r for r in rows if r["name"] == "observer.callback"
                 and r["callback"].startswith("probe" + scenario) and r["prints"] == "1"]
    def callback_name(field):
        suffix = str(field["index"]) if field["index"] >= 0 else ""
        return "probe" + scenario + field["kind"].capitalize() + suffix

    check(fields, "missing native field observations")
    observed_names = [callback_name(f) for f in fields]
    names = [r["callback"] for r in callbacks]
    matches = [i for i in range(len(names) - len(fields) + 1)
               if names[i:i + len(fields)] == observed_names]
    check(len(matches) == 1, "unmatched or ambiguous native field observations")
    first = matches[0]
    if window is not None:
        check(all(first <= i < first + len(fields) for i, r in enumerate(callbacks)
                  if window[0] <= start(r) < window[1]), "partial console coverage of burst")
    callbacks = callbacks[first:first + len(fields)]
    check(all(b["seq"] == a["seq"] + 1 for a, b in zip(fields, fields[1:])),
          "gap or reset in native field sequence")
    updates = defaultdict(list)
    ends = defaultdict(list)
    for r in rows:
        if r["name"] == "transaction.update":
            updates[r["apply_id"]].append(r)
        if r["name"] == "transaction.end":
            ends[(r["apply_id"], r["flow_from"])].append(r)
    groups = defaultdict(list)
    for row, field in zip(callbacks, fields):
        owners = [r for r in updates[row["apply_id"]] if start(r) <= start(row)]
        check(row["apply_id"] != "[NULL]" and owners, "observer has no owning update")
        update = owners[-1]
        tails = ends[(row["apply_id"], update["id"])]
        check(len(tails) == 1 and start(tails[0]) >= end(row), "ambiguous apply completion")
        groups[(start(update), end(tails[0]))].append(field)
    ordered = [(a, b, fs) for (a, b), fs in sorted(groups.items())]
    check(all(a[1] <= b[0] for a, b in zip(ordered, ordered[1:])), "overlapping native updates")
    return ordered


def frames(rows):
    """Pair adjacent main render/swap events; mismatched or partial traces are unknown."""
    events = [r for r in rows if r["track"] == "RenderThr:Main"
              and r["name"] in ("render", "swapBuffers")]
    check(events and len(events) % 2 == 0, "incomplete render/swap pairs")
    output = []
    for render, swap in zip(events[::2], events[1::2]):
        check(render["name"] == "render" and swap["name"] == "swapBuffers"
              and end(render) <= start(swap), "ambiguous render/swap pair")
        output.append((start(render), end(swap)))
    return output


def device_keys(rows, replay):
    commands = [c["key"].lower() for c in replay["commands"]]
    downs = [r for r in rows if r["name"] == "keyEvent" and r["press"] == "1"]
    keys = [r["key"].lower() for r in downs]
    keys = ["select" if k in ("ok", "enter") else k for k in keys]
    expected_keys = commands + ["back"]
    starts = [i for i in range(len(keys)) if keys[i:i + len(expected_keys)] == expected_keys]
    check(len(starts) == 1, "device inputs cannot be aligned to this replay")
    i = starts[0]
    return [start(r) for r in downs[i:i + len(expected_keys)]]


def update(state, field):
    kind, value, index = (field[k] for k in ("kind", "value", "index"))
    if kind in ("focus", "color"):
        check(isinstance(index, int) and 0 <= index < 24, "invalid native card index")
    if kind == "focus":
        check(value is True, "unsupported focus observation")
        state["focus"] = index
    elif kind == "color":
        state[f"color{index}"] = value & 0xffffffff
    elif kind == "title":
        for k in ("height", "lines", "width", "wrap"):
            state[k] = value[k]
        state["text"] = " ".join(value["text"].split())
    elif kind in ("lines", "height", "width", "wrap"):
        state[kind] = value
    elif kind == "scroll":
        check(len(value) == 2 and value[0] == 0, "unexpected scroll axis")
        state["offset"] = -value[1]
    else:
        raise Unmeasured("unsupported native observation " + str(kind))


def score_moves(wanted, seed, keys, groups, pairs):
    # Seed from the settled tree immediately before the route; do not replay setup over it.
    groups = [g for g in groups if keys[0] <= g[0] < keys[-1]]
    focuses = [(a, b, f["index"]) for a, b, fields in groups for f in fields if f["kind"] == "focus"]
    if [i for _, _, i in focuses] != [card for card, _ in wanted]:
        return {"status": "FAIL", "reason": "native focus order disagrees with route",
                "observedFocus": [i for _, _, i in focuses]}
    intervals = []
    state = dict(seed)
    for i, (_, finish, fields) in enumerate(groups):
        for field in fields:
            update(state, field)
        until = groups[i + 1][0] if i + 1 < len(groups) else keys[-1]
        intervals.append((finish, until, dict(state)))
    moves = []
    for i, (card, offset) in enumerate(wanted):
        desired = dict(expected(card, offset), wrap=True)
        next_focus = focuses[i + 1][0] if i + 1 < len(focuses) else keys[-2]
        after = max(keys[i], focuses[i][1])
        windows = [(max(after, a), min(b, next_focus)) for a, b, state in intervals
                   if all(state.get(k) == v for k, v in desired.items())]
        matching = [swap for render, swap in pairs
                    if any(a <= render <= swap <= b for a, b in windows)]
        first = min(matching, default=None)
        moves.append({"card": card + 1, "offset": offset,
                      "nativeStateApplied": any(a <= b for a, b in windows),
                      "beforeNextKey": first is not None and first <= keys[i + 1],
                      "beforeNextFocusOrSelect": first is not None,
                      "eligibleSwapMs": (first - keys[i]) / 1e6 if first is not None else None})
    return {"status": "PASS" if all(m["beforeNextFocusOrSelect"] for m in moves) else "MISS",
            "beforeNextKey": sum(m["beforeNextKey"] for m in moves),
            "beforeNextFocusOrSelect": sum(m["beforeNextFocusOrSelect"] for m in moves),
            "total": len(moves), "moves": moves}


def score(path):
    result = {"run": str(path), "firstVisibleHighlight": "UNMEASURED"}
    try:
        replay = read_json(path / "replay/summary.json")
        result.update(sha256=replay.get("sha256"), route=replay.get("route"),
                      spacingMs=replay.get("spacingMs"), renderer=replay.get("mode"))
        if not replay.get("pass"):
            return dict(result, status="FAIL", reason=replay.get("error") or "input replay failed")
        wanted, seed = validate_replay(replay)
        result["settledActivationAndBack"] = "PASS"
        verify_burst_route(replay)
        trace_clean(path / "trace-stats.csv")
        rows = read_csv(path / "attribution.csv")
        keys = device_keys(rows, replay)
        pairs = frames(rows)
        result["firstSwapMs"] = [next(((s - a) / 1e6 for r, s in pairs if a <= r <= s <= b), None)
                                 for a, b in zip(keys[:-2], keys[1:])]
        groups = epochs(rows, read_json(path / "native-probe.json"), (keys[0], keys[-1]))
        check(any(b <= keys[0] for _, b, _ in groups), "observers not verified before first scored key")
        return dict(result, **score_moves(wanted, seed, keys, groups, pairs))
    except (Unmeasured, OSError, KeyError, IndexError, StopIteration, TypeError, ParseError, json.JSONDecodeError) as exc:
        return dict(result, status="UNKNOWN", reason=str(exc) or "missing evidence")
    except ValueError as exc:
        return dict(result, status="FAIL", reason=str(exc))
