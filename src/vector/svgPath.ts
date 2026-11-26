import { RokuHostError } from "../scene/sceneGraph.types";
export type Point = readonly [number, number];
const failure = (message: string): never => {
  throw new RokuHostError("C09_SVG_PATH", message);
};
const token = /[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g;

/** Bounded SVG path flattening for portable software rasterization. */
export function svgPath(data: string): Point[][] {
  if (data.length > 200_000 || data.replace(token, "").replace(/[\s,]/g, ""))
    failure("Invalid SVG path data");
  const parts = data.match(token) ?? [],
    paths: Point[][] = [];
  let index = 0,
    command = "",
    previous = "",
    x = 0,
    y = 0,
    control: Point = [0, 0],
    count = 0;
  let current: Point[] = [];
  const push = (point: Point) => {
    if (++count > 16_384 || point.some((value) => !Number.isFinite(value) || Math.abs(value) > 1e7))
      failure("SVG path exceeds its coordinate budget");
    current.push(point);
    [x, y] = point;
  };
  const number = () => {
    const value = Number(parts[index++]);
    if (!Number.isFinite(value)) failure("SVG path coordinate is missing");
    return value;
  };
  while (index < parts.length) {
    if (/^[a-zA-Z]$/.test(parts[index])) command = parts[index++];
    if (!command) failure("SVG path has no command");
    const relative = command === command.toLowerCase(),
      type = command.toUpperCase(),
      start: Point = [x, y];
    const point = (): Point => [
      number() + (relative ? start[0] : 0),
      number() + (relative ? start[1] : 0),
    ];
    if (type === "Z") {
      if (current.length) push(current[0]);
      command = "";
    } else if (type === "M") {
      current = [];
      paths.push(current);
      push(point());
      command = relative ? "l" : "L";
    } else if (!current.length) failure("SVG path must begin with move");
    else if (type === "L") push(point());
    else if (type === "H") push([number() + (relative ? x : 0), y]);
    else if (type === "V") push([x, number() + (relative ? y : 0)]);
    else if (["C", "S", "Q", "T"].includes(type)) {
      const reflected: Point = [2 * x - control[0], 2 * y - control[1]];
      const a =
        type === "C" || type === "Q"
          ? point()
          : ["S", "T"].includes(type) && (type === "S" ? ["C", "S"] : ["Q", "T"]).includes(previous)
            ? reflected
            : start;
      const b = type === "C" || type === "S" ? point() : a,
        end = point();
      const steps = Math.min(
        128,
        Math.max(
          8,
          Math.ceil(
            (Math.hypot(a[0] - x, a[1] - y) +
              Math.hypot(b[0] - a[0], b[1] - a[1]) +
              Math.hypot(end[0] - b[0], end[1] - b[1])) /
              4,
          ),
        ),
      );
      for (let step = 1; step <= steps; step++) {
        const t = step / steps,
          u = 1 - t;
        push(
          type === "Q" || type === "T"
            ? [
                u * u * start[0] + 2 * u * t * a[0] + t * t * end[0],
                u * u * start[1] + 2 * u * t * a[1] + t * t * end[1],
              ]
            : [
                u * u * u * start[0] +
                  3 * u * u * t * a[0] +
                  3 * u * t * t * b[0] +
                  t * t * t * end[0],
                u * u * u * start[1] +
                  3 * u * u * t * a[1] +
                  3 * u * t * t * b[1] +
                  t * t * t * end[1],
              ],
        );
      }
      control = type === "Q" || type === "T" ? a : b;
    } else if (type === "A") {
      let rx = Math.abs(number()),
        ry = Math.abs(number());
      const rotation = (number() * Math.PI) / 180,
        large = number(),
        sweep = number(),
        end = point();
      if (![0, 1].includes(large) || ![0, 1].includes(sweep))
        failure("SVG arc flags must be zero or one");
      if (!rx || !ry || (x === end[0] && y === end[1])) push(end);
      else {
        const cos = Math.cos(rotation),
          sin = Math.sin(rotation),
          dx = (x - end[0]) / 2,
          dy = (y - end[1]) / 2;
        const px = cos * dx + sin * dy,
          py = -sin * dx + cos * dy,
          stretch = (px * px) / (rx * rx) + (py * py) / (ry * ry);
        if (stretch > 1) {
          rx *= Math.sqrt(stretch);
          ry *= Math.sqrt(stretch);
        }
        const factor =
          (large === sweep ? -1 : 1) *
          Math.sqrt(
            Math.max(
              0,
              (rx * rx * ry * ry - rx * rx * py * py - ry * ry * px * px) /
                (rx * rx * py * py + ry * ry * px * px),
            ),
          );
        const cx = (factor * rx * py) / ry,
          cy = (-factor * ry * px) / rx;
        const center: Point = [
          cos * cx - sin * cy + (x + end[0]) / 2,
          sin * cx + cos * cy + (y + end[1]) / 2,
        ];
        const from = Math.atan2((py - cy) / ry, (px - cx) / rx),
          to = Math.atan2((-py - cy) / ry, (-px - cx) / rx);
        let angle = to - from;
        if (sweep && angle < 0) angle += Math.PI * 2;
        if (!sweep && angle > 0) angle -= Math.PI * 2;
        const steps = Math.max(1, Math.ceil(Math.abs(angle) / (Math.PI / 64)));
        for (let step = 1; step <= steps; step++) {
          const theta = from + (angle * step) / steps,
            ax = rx * Math.cos(theta),
            ay = ry * Math.sin(theta);
          push(
            step === steps
              ? end
              : [center[0] + cos * ax - sin * ay, center[1] + sin * ax + cos * ay],
          );
        }
      }
    } else failure(`SVG command ${command} is unavailable`);
    previous = type;
  }
  return paths;
}
