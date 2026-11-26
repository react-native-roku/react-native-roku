"""Instrument native focus, paint and activation for the selected public catalog route."""

from copy import copy
from hashlib import sha256
import json
import argparse
from pathlib import Path
from zipfile import ZipFile


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("source", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("--sustained", action="store_true", help="observe the nine-direction destinations")
args = parser.parse_args()
source, output = args.source, args.output
component = "components/HelloRokuScene.brs"
probe = Path(__file__).with_name("direction-probe.brs").read_text()
if args.sustained:
    plan = json.loads(Path(__file__).with_name("plan.json").read_text())
    ids = [plan["start"]["id"]] + [plan["first"]["id"] + 4*i for i in range(9)]
    initial = '["catalog-card-27", "catalog-card-31", "catalog-card-35"]'
    if probe.count(initial) != 1:
        raise ValueError("Native focus instrumentation anchor changed")
    probe = probe.replace(initial, json.dumps(["catalog-card-" + str(i) for i in ids]))
assert not output.exists()
with ZipFile(source) as exact, ZipFile(output, "x") as marked:
    original = exact.read(component).decode()
    entry = original.index("end sub")
    assert "sub init(" in original[:entry].lower() and "startDeepProbe" not in original
    replacement = original[:entry] + "    startDeepProbe()\n" + original[entry:] + "\n" + probe
    bundle = "source/compiled/index.js"
    js = exact.read(bundle).decode()
    anchor = "      position.current = next;\n      setDetail(next.card);"
    if js.count(anchor) != 1:
        raise ValueError("Catalog activation marker anchor changed")
    js = js.replace(anchor, '      console.log("RNR_BURST_OPEN|" + JSON.stringify({id: next.card.index, offset: next.offset}));\n' + anchor)
    for member in exact.infolist():
        marked.writestr(copy(member), replacement.encode() if member.filename == component
                        else js.encode() if member.filename == bundle else exact.read(member))
with ZipFile(source) as exact, ZipFile(output) as marked:
    assert exact.namelist() == marked.namelist()
    assert {name for name in exact.namelist() if exact.read(name) != marked.read(name)} == {component, bundle}
with Path(str(output) + ".json").open("x") as evidence:
    json.dump({
        "exactZipSha256": sha256(source.read_bytes()).hexdigest(),
        "markedZipSha256": sha256(output.read_bytes()).hexdigest(),
        "sustained": args.sustained,
        "changed": [component, bundle],
    }, evidence, indent=2)
