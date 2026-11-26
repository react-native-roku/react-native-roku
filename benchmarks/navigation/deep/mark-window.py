"""Add BRS-only visible-state observations to an exact public catalog ZIP."""

from copy import copy
from hashlib import sha256
import json
import sys
from pathlib import Path
from zipfile import ZipFile


source, output = map(Path, sys.argv[1:])
component = "components/HelloRokuScene.brs"
probe = Path(__file__).with_name("deep-native-probe.brs").read_text()
assert not output.exists()
with ZipFile(source) as exact, ZipFile(output, "x") as marked:
    original = exact.read(component).decode()
    entry = original.index("end sub")
    assert "sub init(" in original[:entry].lower() and "startDeepProbe" not in original
    replacement = original[:entry] + "    startDeepProbe()\n" + original[entry:] + "\n" + probe
    for member in exact.infolist():
        marked.writestr(copy(member), replacement.encode() if member.filename == component
                        else exact.read(member))
with ZipFile(source) as exact, ZipFile(output) as marked:
    assert exact.namelist() == marked.namelist()
    assert [name for name in exact.namelist() if exact.read(name) != marked.read(name)] == [component]
with Path(str(output) + ".json").open("x") as evidence:
    json.dump({
        "exactZipSha256": sha256(source.read_bytes()).hexdigest(),
        "markedZipSha256": sha256(output.read_bytes()).hexdigest(),
        "changed": [component],
    }, evidence, indent=2)
