const PAINT =
  /^(?:key|children|style|fill(?:Rule|Opacity)?|stroke.*|color|opacity|vectorEffect|testID|accessible|accessibility.*|pointerEvents)$/;
export function svgShapeKey(viewBox, nodes) {
  return JSON.stringify([
    String(viewBox).trim().replace(/[ ,]+/g, " "),
    nodes.map(([tag, attributes]) => [
      tag.toLowerCase(),
      Object.fromEntries(
        Object.entries(attributes)
          .filter(([key, value]) => value != null && !PAINT.test(key))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => [key, String(value)]),
      ),
    ]),
  ]);
}
