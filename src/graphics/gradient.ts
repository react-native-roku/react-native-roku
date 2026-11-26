import { RokuHostError, type SceneFields } from "../scene/sceneGraph.types";
export interface GradientSpec {
  readonly start: { x: number; y: number };
  readonly end: { x: number; y: number };
  readonly locations: readonly number[];
}
/** Project authored endpoints onto the Effect's full-box gradient axis. */
export function gradientFields(spec: GradientSpec, width: number, height: number): SceneFields {
  if (
    ![spec.start.x, spec.start.y, spec.end.x, spec.end.y, ...spec.locations].every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 1,
    )
  )
    throw new RokuHostError(
      "C03_GRADIENT",
      "Gradient endpoints and stops must be finite within [0,1]",
    );
  if (spec.locations.some((value, index) => index > 0 && value < spec.locations[index - 1]))
    throw new RokuHostError("C03_GRADIENT", "Gradient stops must be ordered");
  if (!width || !height) return { gradientAngle: 0, gradientStops: spec.locations };
  const gx = (spec.end.x - spec.start.x) * width,
    gy = (spec.end.y - spec.start.y) * height,
    length = Math.hypot(gx, gy);
  if (!length) throw new RokuHostError("C03_GRADIENT", "A gradient requires distinct endpoints");
  const dx = gx / length,
    dy = gy / length,
    minimum = Math.min(0, width * dx) + Math.min(0, height * dy),
    span = Math.abs(width * dx) + Math.abs(height * dy);
  const start = spec.start.x * width * dx + spec.start.y * height * dy;
  return {
    // SceneGraph measures clockwise from up in screen coordinates.
    gradientAngle: ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360,
    gradientStops: spec.locations.map((stop) =>
      Math.max(0, Math.min(1, (start + stop * length - minimum) / span)),
    ),
  };
}
