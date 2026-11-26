"""Instrument a disposable unpacking of a catalog runtime archive."""
import sys
from pathlib import Path

root = Path(sys.argv[1])
module = root / "src/catalogGeometryProbe.ts"
module.write_text("""type Perf = { roku?: { perfetto?: { instantEvent(name: string, fields: Record<string, number>): void } } };
const counters = {
  started: 0, widths: 0, heights: 0, widthMs: 0, heightMs: 0,
  yogaBuildMs: 0, yogaSolveMs: 0, yogaReadMs: 0, yogaFreeMs: 0, measureMs: 0,
};
const shared = globalThis as typeof globalThis & { __rnrCatalogGeometry?: typeof counters };
export const geometry = shared.__rnrCatalogGeometry ??= { ...counters };
export function beginGeometry() { Object.assign(geometry, counters, { started: performance.now() }); }
export function reportGeometry() {
  const trace = (globalThis as Perf).roku?.perfetto;
  const { started, widths, heights, widthMs, heightMs, measureMs,
    yogaBuildMs, yogaSolveMs, yogaReadMs, yogaFreeMs } = geometry;
  trace?.instantEvent("catalog.geometry", {
    geometryMs: performance.now() - started, widths, heights, widthMs, heightMs, measureMs,
  });
  trace?.instantEvent("catalog.yoga", { yogaBuildMs, yogaSolveMs, yogaReadMs, yogaFreeMs });
}
export function reportFields(fieldsMs: number) {
  (globalThis as Perf).roku?.perfetto?.instantEvent("catalog.fields", { fieldsMs });
}
""")

def patch(path, replacements, imports):
    source = root / path
    code = source.read_text()
    for before, after in replacements:
        assert code.count(before) == 1, (path, before)
        code = code.replace(before, after)
    source.write_text(imports + code)

patch("src/scene/SdkTextMetrics.ts", [
    ("          const lineHeight = api.getOneLineHeight(ref);", """          const heightStarted = performance.now();
          const lineHeight = api.getOneLineHeight(ref);
          geometry.heights++;
          geometry.heightMs += performance.now() - heightStarted;"""),
    ("              const width = api.getOneLineWidth(ref, text, 2_147_483_647);", """              const widthStarted = performance.now();
              const width = api.getOneLineWidth(ref, text, 2_147_483_647);
              geometry.widths++;
              geometry.widthMs += performance.now() - widthStarted;"""),
], 'import { geometry } from "../catalogGeometryProbe";\n')
native_root = (root / "src/react-native/createNativeRoot.ts").read_text()
layout_start = (
    "        let isolated: Map<LayoutInput, LayoutRect> | undefined;"
    if "        let isolated:" in native_root
    else "        const layout = reuse"
)
patch("src/react-native/createNativeRoot.ts", [
    (layout_start, "        beginGeometry();\n" + layout_start),
    ("        const prepareNode = preparedFields.begin",
     "        reportGeometry();\n        const fieldsStarted = performance.now();\n"
     "        const prepareNode = preparedFields.begin"),
    ("        pending.set(tree, { entries: next, local });",
     "        reportFields(performance.now() - fieldsStarted);\n"
     "        pending.set(tree, { entries: next, local });"),
], 'import { beginGeometry, reportGeometry, reportFields } from "../catalogGeometryProbe";\n')

patch("src/layout/flexLayout.ts", [
    ("        const result = measureText(", """        const measureStarted = performance.now();
        const result = measureText("""),
    ("        if (\n          !Number.isFinite(result.width)", """        geometry.measureMs += performance.now() - measureStarted;
        if (
          !Number.isFinite(result.width)"""),
    ("  try {\n    const root = build(input);", """  let yogaStarted = performance.now();
  try {
    const root = build(input);
    geometry.yogaBuildMs = performance.now() - yogaStarted;
    yogaStarted = performance.now();"""),
    ("    return new Map(\n      [...nodes]", """    geometry.yogaSolveMs = performance.now() - yogaStarted;
    yogaStarted = performance.now();
    return new Map(
      [...nodes]"""),
    ("    // Individual frees", """    geometry.yogaReadMs = performance.now() - yogaStarted;
    yogaStarted = performance.now();
    // Individual frees"""),
    ("    Yoga.Config.destroy(config);", """    Yoga.Config.destroy(config);
    geometry.yogaFreeMs = performance.now() - yogaStarted;"""),
], 'import { geometry } from "../catalogGeometryProbe";\n')
