"""Create disposable field or focus-recovery probes from frozen ZIPs."""

import argparse
from copy import copy
import os
import re
import tempfile
from pathlib import Path
from zipfile import ZipFile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("source", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("renderer", choices=["react", "solid"])
mode = parser.add_mutually_exclusive_group()
mode.add_argument("--holdout", action="store_true")
mode.add_argument("--recovery", action="store_true")
args = parser.parse_args()
source, output, renderer = args.source, args.output, args.renderer
name = "ReactShelfScene" if renderer == "react" else "NativeShelfScene"
component = f"components/{name}.brs"
if args.recovery:
    if renderer != "react":
        parser.error("the recovery probe needs a React Native catalog ZIP")
    component = "source/compiled/index.js"

probe = """
sub startCatalogProbe()
    m.catalogProbe = CreateObject("roSGNode", "Timer")
    m.catalogProbe.duration = 0.1
    m.catalogProbe.repeat = true
    m.catalogProbe.observeFieldScoped("fire", "attachCatalogProbe")
    m.catalogProbe.control = "start"
end sub

sub attachCatalogProbe()
    title = m.top.findNode("selection")
    window = m.top.findNode("catalog-window")
    if title = invalid or window = invalid or m.top.findNode("shelf-23") = invalid then return
    m.catalogProbe.control = "stop"
    m.catalogProbe.unobserveFieldScoped("fire")
    m.catalogProbeSequence = 0
    m.catalogTitle = title
    if window.getChildCount() <> 1 then return
    m.catalogScroll = window.getChild(0)
    title.observeFieldScoped("text", "probeCatalogTitle")
    title.observeFieldScoped("width", "probeCatalogWidth")
    title.observeFieldScoped("wrap", "probeCatalogWrap")
    title.observeFieldScoped("height", "probeCatalogHeight")
    title.observeFieldScoped("numLines", "probeCatalogLines")
    m.catalogScroll.observeFieldScoped("translation", "probeCatalogScroll")
    for index = 0 to 23
        suffix = index.toStr().trim()
        node = m.top.findNode("shelf-" + suffix)
        if node = invalid or node.getChildCount() < 1 then return
        node.observeFieldScoped("focusedChild", "probeCatalogFocus" + suffix)
        node.getChild(0).observeFieldScoped("color", "probeCatalogColor" + suffix)
    end for
    print "RNR_CATALOG_READY"
end sub

sub reportCatalogProbe(kind as String, value as Dynamic, index = -1 as Integer)
    m.catalogProbeSequence = m.catalogProbeSequence + 1
    print "RNR_CATALOG_FIELD|" + FormatJson({ seq: m.catalogProbeSequence, kind: kind, value: value, index: index })
end sub

sub probeCatalogTitle(event as Object)
    reportCatalogProbe("title", { text: event.getData(), width: m.catalogTitle.width, height: m.catalogTitle.height, lines: m.catalogTitle.numLines, wrap: m.catalogTitle.wrap })
end sub

sub probeCatalogWidth(event as Object)
    reportCatalogProbe("width", event.getData())
end sub

sub probeCatalogWrap(event as Object)
    reportCatalogProbe("wrap", event.getData())
end sub

sub probeCatalogHeight(event as Object)
    reportCatalogProbe("height", event.getData())
end sub

sub probeCatalogLines(event as Object)
    reportCatalogProbe("lines", event.getData())
end sub

sub probeCatalogScroll(event as Object)
    reportCatalogProbe("scroll", event.getData())
end sub
"""
for index in range(24):
    probe += f"""
sub probeCatalogFocus{index}(event as Object)
    if event.getRoSGNode().hasFocus() then reportCatalogProbe("focus", true, {index})
end sub

sub probeCatalogColor{index}(event as Object)
    reportCatalogProbe("color", event.getData(), {index})
end sub
"""

entry = "startHoldoutProbe" if args.holdout else "startCatalogProbe"
if args.holdout:
    probe = Path(__file__).with_name("holdout").joinpath("probe.brs").read_text()

def instrument(code):
    if args.recovery:
        observer = re.compile(r"\bfocusedChild: \(value\) => (?P<port>[\w$]+)\.observeFocus\("
                              r"(?P<id>[\w$]+), value === (?P=id)\)")
        marker = "RNR_WITHHELD_FOCUS|shelf-1"
        if marker in code or len(observer.findall(code)) != 1:
            parser.error("expected one unmodified Pressable native focus observer")
        return observer.sub(
            lambda match: ("focusedChild: (value) => { const probeID = "
                           + match['id'] + "; if (probeID === 'shelf-1' && value === probeID && "
                           "!globalThis.__RNR_RECOVERY_WITHHELD__) { "
                           "globalThis.__RNR_RECOVERY_WITHHELD__ = true; console.log('"
                           + marker + "'); return; } "
                           + match['port'] + ".observeFocus(probeID, value === probeID); }"),
            code,
        )
    if "sub " + entry + "()" in code:
        parser.error("source already contains the requested field observers")
    # Replace the optional focus-only diagnostic to avoid duplicate observations.
    code = code.replace("\n startShelfFocusProbe()\n", "\n", 1)
    end = code.index("end sub")
    return code[:end] + "    " + entry + "()\n" + code[end:] + "\n" + probe


with ZipFile(source) as original:
    modified = instrument(original.read(component).decode()).encode()
    with tempfile.NamedTemporaryFile(dir=output.parent) as temp:
        with ZipFile(temp.name, "w") as derived:
            for entry in original.infolist():
                derived.writestr(copy(entry), modified if entry.filename == component else original.read(entry))
        with ZipFile(temp.name) as derived:
            if derived.testzip() or [n for n in original.namelist()
                                     if original.read(n) != derived.read(n)] != [component]:
                raise ValueError("unexpected differences in the instrumented ZIP")
        os.link(temp.name, output)  # Exclusive publication after the entire archive verifies.
