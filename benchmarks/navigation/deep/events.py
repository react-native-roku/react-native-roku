"""Load captured keys, native transactions and SDK swaps without mixing clocks."""
import csv
import json
from collections import defaultdict
from pathlib import Path
from statistics import median
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from burst import check, end, epochs, frames, read_csv, read_json, start, trace_clean



def optional(row, field):
    value = row[field]
    return None if value == "[NULL]" else int(value)


def flow_index(rows):
    index = defaultdict(list)
    for row in rows:
        index[(row["name"], optional(row, "flow_from"))].append(row)
    return index


def unique(items):
    return items[0] if len(items) == 1 else None


def norm(key):
    return "select" if key.lower() in ("ok", "enter") else key.lower()


def elapsed(a, b):
    return None if a is None or b is None else round((b-a) / 1e6, 4)


class Run:
    def __init__(self, path, transport_path=None):
        self.path = path
        self.replay = read_json(path / "replay/summary.json")
        self.rows = read_csv(path / "attribution.csv")
        trace_clean(path / "trace-stats.csv")
        self.keys = [r for r in self.rows if r["name"] == "keyEvent" and r["press"] == "1"]
        self.key_names = [norm(k["key"]) for k in self.keys]
        self.command_names = [norm(c["key"]) for c in (self.replay.get("commands") or self.replay["steps"])]
        self.keys_match = self.key_names == self.command_names
        self.swaps = frames(self.rows)
        self.native = []
        self.trace_index = {int(row["id"]): row for row in self.rows}
        links = flow_index(self.rows)
        for c in self.rows:
            if c["name"] != "transaction.commit" or c["track"] != "ts_event_dev":
                continue
            u = unique(links["transaction.update", int(c["id"])])
            e = unique(links["transaction.end", int(u["id"])]) if u else None
            parent = self.trace_index.get(optional(c, "flow_from"))
            if e and parent and end(e) >= start(c):
                self.native.append(dict(
                    start=start(parent), commit=start(c), applyStart=start(u), apply=end(e),
                    applyThread=u["track"], render=self.swap_after(end(e))[0],
                    swap=self.swap_after(end(e))[1], marks=[]))
        mark_file = path / "native-probe.json"
        self.marked = mark_file.is_file()
        self.activations = []
        if self.marked:
            probe = read_json(mark_file)
            grouped = epochs(self.rows, probe, scenario="Deep")
            for a, b, marks in grouped:
                candidates = [d for d in self.native if (d["applyStart"], d["apply"]) == (a, b)]
                if len(candidates) == 1:
                    candidates[0]["marks"].extend(marks)
            for line in probe["lines"]:
                if "RNR_BURST_OPEN|" in line:
                    data = line.split("RNR_BURST_OPEN|", 1)[1].strip()
                    if data.startswith("{"):
                        value, _ = json.JSONDecoder().raw_decode(data)
                        self.activations.append(value)
        transport_path = transport_path or path / "transport.csv"
        if not transport_path.exists():
            raise ValueError("Missing transport.csv. Run suite.py extract on the saved trace first.")
        self.transport = read_csv(transport_path)
        self.transfer_links = flow_index(self.transport)
        self.fields_by_parent = defaultdict(list)
        self.transfer_starts_by_parent = defaultdict(list)
        for r in self.transport:
            if r["name"] == "roSGNode.setField":
                self.fields_by_parent[optional(r, "parent_id")].append(r)
            if r["name"] == "transaction.toTS.start":
                self.transfer_starts_by_parent[optional(r, "parent_id")].append(r)
        self.transport_starts = [r for r in self.transport if r["name"] == "transaction.toTS.start"]

    def swap_after(self, applied, before=float("inf")):
        return next(((r, s) for r, s in self.swaps if applied <= r < before),
                    (None, None))

    def key_transfer(self, key):
        # The key and ExecBrightScript share the main-thread task. The ensuing
        # KeyHandler keyEvent field's flow identifies this precise JS delivery.
        parent = optional(key, "parent_id")
        candidates = [f for f in self.fields_by_parent.get(parent, ())]
        # ExecBrightScript is omitted from attribution.csv. On the same thread,
        # nested KeyHandler field writes must be contained by the key's task.
        task = self.trace_index.get(parent)
        if task is not None and not candidates:
            candidates = [r for related in self.fields_by_parent.values() for r in related
                          if r["track"] == key["track"] and start(key) <= start(r) <= end(task)]
        f = unique(candidates)
        a = unique(self.transfer_starts_by_parent.get(int(f["id"]), [])) if f else None
        return dict(field=start(f) if f else None, **self.transfer(a))

    def transfer(self, native_start):
        c = unique(self.transfer_links["transaction.toTS.commit", int(native_start["id"])]) if native_start else None
        u = unique(self.transfer_links["transaction.toTS.update", int(c["id"])]) if c else None
        e = unique(self.transfer_links["transaction.toTS.end", int(u["id"])]) if u else None
        return dict(send=start(c) if c else None, receive=start(u) if u else None, end=end(e) if e else None)

    def direction(self, key):
        bridge = self.key_transfer(key)
        check(all(bridge.values()), "unlinked key transfer")
        anchor = unique([d for d in self.native if bridge["receive"] <= d["start"] <= bridge["end"]])
        check(anchor is not None, "unlinked directional focus transaction")
        notifications = [self.transfer(r) for r in self.transport_starts
                         if r["track"] == anchor["applyThread"] and
                         anchor["applyStart"] <= start(r) <= anchor["apply"]]
        candidates = []
        for n in notifications:
            if n["receive"] is None or n["end"] is None:
                continue
            for d in self.native:
                if n["receive"] <= d["start"] <= n["end"]:
                    candidates.append((d, n))
        colored = unique(candidates)
        check(colored is not None, "unlinked directional highlight/scroll transaction")
        return bridge, anchor, colored[0], colored[1]

    def around(self, t1, t2, back):
        return [d for d in self.native if t1 <= d["commit"] < back]


def focus(value, state, *, paint=True):
    return (value["focus"] == [state["id"]] and value["offset"] == state["offset"] and
            (not paint or value.get("color", 0) & 0xffffffff == 0x3456c0ff) and
            value["position"] == f'{state["id"]+1} of 72' and
            value["clip"] == {"x": 0, "y": 0, "width": 1560, "height": 680})


def inspect_run(path):
    run = Run(path)
    plan = read_json(HERE / "plan.json")
    print(path.name, run.keys_match, len(run.keys), len(run.command_names), run.activations)
    if not run.keys_match:
        print(list(zip(run.key_names, run.command_names)))
        return
    for trial in run.replay["trials"]:
        if not trial.get("burst"):
            print(trial); continue
        keys = {phase: run.keys[i] for phase, i in trial["burst"].items()}
        t = {phase: start(k) for phase, k in keys.items()}
        print(trial["route"], "seed", trial["seed"].get("rows"), "detail", trial["detail"],
              "restore", trial["restoration"])
        for phase, key in keys.items():
            transfer = run.key_transfer(key)
            print(phase, elapsed(t["first"], t[phase]),
                  {k: elapsed(t["first"], v) for k, v in transfer.items()})
        for i, d in enumerate(run.around(t["first"], t["second"], t["back"])):
            print(i, [elapsed(t["first"], d[k]) for k in ("start","commit","apply","render","swap")],
                  [[m["kind"], m["value"]["focus"], m["value"]["offset"], m["value"]["spacer"],
                    m["value"]["position"], m["value"]["rows"]] for m in d["marks"]])


if __name__ == "__main__":
    for path in sys.argv[1:]:
        inspect_run(Path(path))
