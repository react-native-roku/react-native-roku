import { RokuHostError, type SceneFields } from "../scene/sceneGraph.types";
import type { LayoutRect } from "./flexLayout";

/** Compose RN's ordered 2D transforms, then admit only matrices RSG can represent exactly. */
export function sceneTransform(value: unknown, rect: LayoutRect, origin?: unknown): SceneFields {
  if (!Array.isArray(value))
    throw new RokuHostError("C03_TRANSFORM", "Transform must be an ordered array");
  let a = 1,
    b = 0,
    c = 0,
    d = 1,
    x = 0,
    y = 0;
  for (const operation of value) {
    if (!operation || typeof operation !== "object" || Object.keys(operation).length !== 1)
      throw new RokuHostError("C03_TRANSFORM", "Each transform needs one operation");
    const [key, operand] = Object.entries(operation)[0];
    let na = 1,
      nb = 0,
      nc = 0,
      nd = 1,
      nx = 0,
      ny = 0;
    if (typeof operand === "number" && Number.isFinite(operand)) {
      if (key === "translateX") nx = operand;
      else if (key === "translateY") ny = operand;
      else if (key === "scale") na = nd = operand;
      else if (key === "scaleX") na = operand;
      else if (key === "scaleY") nd = operand;
      else throw new RokuHostError("C03_TRANSFORM", `Transform ${key} needs an implementation`);
    } else if (
      (key === "rotate" || key === "rotateZ") &&
      typeof operand === "string" &&
      /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:deg|rad)$/.test(operand)
    ) {
      const angle = Number.parseFloat(operand) * (operand.endsWith("deg") ? Math.PI / 180 : 1);
      na = nd = Math.cos(angle);
      nb = Math.sin(angle);
      nc = -nb;
    } else
      throw new RokuHostError(
        "C03_TRANSFORM",
        `Transform ${key} is not a finite supported 2D operation`,
      );
    const nextX = a * nx + c * ny + x,
      nextY = b * nx + d * ny + y;
    [a, b, c, d, x, y] = [
      a * na + c * nb,
      b * na + d * nb,
      a * nc + c * nd,
      b * nc + d * nd,
      nextX,
      nextY,
    ];
  }
  const first = Math.hypot(a, b),
    second = Math.hypot(c, d),
    determinant = a * d - b * c;
  if (Math.abs(a * c + b * d) > 1e-8 * Math.max(1, first * second))
    throw new RokuHostError(
      "C03_TRANSFORM_SHEAR",
      "This ordered transform requires nested RSG groups to preserve shear",
    );
  const rotation = first > 1e-12 ? Math.atan2(b, a) : second > 1e-12 ? Math.atan2(-c, d) : 0;
  const sx = first > 1e-12 ? first : second > 1e-12 ? determinant / second : 0;
  const sy = first > 1e-12 ? determinant / first : second;
  return {
    translation: [rect.x + x, rect.y + y],
    scale: [sx, sy],
    rotation,
    scaleRotateCenter: transformOrigin(origin, rect.width, rect.height),
  };
}

/** RN's two-dimensional CSS/array origin, in the view's local coordinates. */
export function transformOrigin(
  value: unknown,
  width: number,
  height: number,
): readonly [number, number] {
  if (value == null) return [width / 2, height / 2];
  const parts: unknown[] =
    typeof value === "string" ? value.trim().split(/\s+/) : Array.isArray(value) ? [...value] : [];
  if (parts.length < 1 || parts.length > 3)
    throw new RokuHostError(
      "C03_TRANSFORM_ORIGIN",
      "Transform origin requires two planar coordinates",
    );
  if (parts.length === 3 && ![0, "0", "0px"].includes(parts.pop() as never))
    throw new RokuHostError(
      "C03_TRANSFORM_ORIGIN",
      "A nonzero transform origin depth requires a 3D renderer",
    );
  if (parts.length === 1) {
    if (["top", "bottom"].includes(String(parts[0]))) parts.unshift("center");
    else parts.push("center");
  }
  if (["top", "bottom"].includes(String(parts[0])) || ["left", "right"].includes(String(parts[1])))
    parts.reverse();
  const coordinate = (part: unknown, size: number, start: string, end: string) => {
    if (part === start) return 0;
    if (part === end) return size;
    if (part === "center") return size / 2;
    if (typeof part === "number" && Number.isFinite(part)) return part;
    if (typeof part === "string" && /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:%|px)?$/.test(part))
      return Number.parseFloat(part) * (part.endsWith("%") ? size / 100 : 1);
    throw new RokuHostError("C03_TRANSFORM_ORIGIN", "Unsupported transform origin coordinate");
  };
  return [
    coordinate(parts[0], width, "left", "right"),
    coordinate(parts[1], height, "top", "bottom"),
  ];
}
