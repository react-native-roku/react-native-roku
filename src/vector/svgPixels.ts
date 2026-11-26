import type { Point } from "./svgPath";
import { rokuColor } from "../react-native/styleSheet";
import { RokuHostError } from "../scene/sceneGraph.types";
export interface VectorPaint {
  readonly paths: readonly (readonly Point[])[];
  readonly fill?: string;
  readonly stroke?: string;
  readonly strokeWidth?: number;
  readonly opacity?: number;
  readonly fillOpacity?: number;
  readonly strokeOpacity?: number;
}
const color = (value?: string): number[] => {
  if (!value || value === "none" || value === "transparent") return [0, 0, 0, 0];
  const packed = Number(rokuColor(value));
  return [(packed >>> 24) & 255, (packed >>> 16) & 255, (packed >>> 8) & 255, (packed & 255) / 255];
};

/** Nonzero winding fill and unioned stroke masks; source-over RGBA composition. */
export function svgPixels(
  width: number,
  height: number,
  commands: readonly VectorPaint[],
): Uint8Array {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 2048 ||
    height > 2048 ||
    commands.length > 2048
  )
    throw new RokuHostError(
      "C09_RASTER_BUDGET",
      "SVG raster dimensions or command count exceed the budget",
    );
  const result = new Uint8Array(width * height * 4);
  const blend = (index: number, ink: number[], opacity: number, coverage: number) => {
    const front = ink[3] * opacity * coverage,
      back = result[index + 3] / 255,
      alpha = front + back * (1 - front);
    if (!front) return;
    for (let channel = 0; channel < 3; channel++)
      result[index + channel] = Math.round(
        (ink[channel] * front + result[index + channel] * back * (1 - front)) / alpha,
      );
    result[index + 3] = Math.round(alpha * 255);
  };
  for (const command of commands) {
    const fill = color(command.fill),
      stroke = color(command.stroke),
      opacity = command.opacity ?? 1;
    const edges = command.paths.flatMap((path) =>
      path.slice(1).map((b, index) => [path[index], b] as const),
    );
    const points = command.paths.flat();
    if (!points.length) continue;
    const ys = points.map((point) => point[1]),
      top = Math.max(0, Math.floor(Math.min(...ys))),
      bottom = Math.min(height, Math.ceil(Math.max(...ys)));
    if (fill[3])
      for (let y = top; y < bottom; y++) {
        const coverage = new Float32Array(width);
        for (const sample of [0.25, 0.75]) {
          const scan = y + sample;
          const crossings = command.paths
            .flatMap((path) =>
              path.map((a, index) => {
                const b = path[(index + 1) % path.length];
                return (a[1] <= scan && b[1] > scan) || (b[1] <= scan && a[1] > scan)
                  ? {
                      x: a[0] + ((scan - a[1]) * (b[0] - a[0])) / (b[1] - a[1]),
                      winding: b[1] > a[1] ? 1 : -1,
                    }
                  : null;
              }),
            )
            .filter((value): value is { x: number; winding: number } => value !== null)
            .sort((a, b) => a.x - b.x);
          let winding = 0,
            from = 0;
          for (const crossing of crossings) {
            if (winding)
              for (
                let x = Math.max(0, Math.floor(from));
                x < Math.min(width, Math.ceil(crossing.x));
                x++
              )
                coverage[x] +=
                  (Number(x + 0.25 >= from && x + 0.25 < crossing.x) +
                    Number(x + 0.75 >= from && x + 0.75 < crossing.x)) /
                  4;
            winding += crossing.winding;
            from = crossing.x;
          }
        }
        for (let x = 0; x < width; x++)
          if (coverage[x])
            blend((y * width + x) * 4, fill, opacity * (command.fillOpacity ?? 1), coverage[x]);
      }
    const radius = (command.strokeWidth ?? 1) / 2;
    if (stroke[3] && radius > 0) {
      const coverage = new Float32Array(width * height);
      for (const [a, b] of edges) {
        const dx = b[0] - a[0],
          dy = b[1] - a[1],
          length = dx * dx + dy * dy;
        if (!length) continue;
        const x1 = Math.max(0, Math.floor(Math.min(a[0], b[0]) - radius - 1)),
          x2 = Math.min(width, Math.ceil(Math.max(a[0], b[0]) + radius + 1));
        const y1 = Math.max(0, Math.floor(Math.min(a[1], b[1]) - radius - 1)),
          y2 = Math.min(height, Math.ceil(Math.max(a[1], b[1]) + radius + 1));
        for (let y = y1; y < y2; y++)
          for (let x = x1; x < x2; x++) {
            const t = Math.max(
              0,
              Math.min(1, ((x + 0.5 - a[0]) * dx + (y + 0.5 - a[1]) * dy) / length),
            );
            const distance = Math.hypot(x + 0.5 - a[0] - t * dx, y + 0.5 - a[1] - t * dy);
            coverage[y * width + x] = Math.max(
              coverage[y * width + x],
              Math.max(0, Math.min(1, radius + 0.5 - distance)),
            );
          }
      }
      for (let index = 0; index < coverage.length; index++)
        if (coverage[index])
          blend(index * 4, stroke, opacity * (command.strokeOpacity ?? 1), coverage[index]);
    }
  }
  return result;
}
