import type { SceneFields } from "../scene/sceneGraph.types";
import type { LayoutRect } from "./flexLayout";
export type Affine = readonly [number, number, number, number, number, number];
export const identityAffine: Affine = [1, 0, 0, 1, 0, 0];
export function multiplyAffine(a: Affine, b: Affine): Affine {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
export function sceneAffine(fields: SceneFields): Affine {
  const translation = (fields.translation as readonly number[] | undefined) ?? [0, 0],
    scale = (fields.scale as readonly number[] | undefined) ?? [1, 1],
    center = (fields.scaleRotateCenter as readonly number[] | undefined) ?? [0, 0],
    angle = Number(fields.rotation ?? 0),
    cosine = Math.cos(angle),
    sine = Math.sin(angle);
  const a = cosine * scale[0],
    b = sine * scale[0],
    c = -sine * scale[1],
    d = cosine * scale[1];
  return [
    a,
    b,
    c,
    d,
    translation[0] + center[0] - a * center[0] - c * center[1],
    translation[1] + center[1] - b * center[0] - d * center[1],
  ];
}
/** Layout-only nodes inherit their parent's linear transform. A child at its
 * parent's origin can share that entire immutable matrix. */
export function sceneWorld(parent: Affine, fields: SceneFields): Affine {
  if (fields.scale == null && fields.rotation == null && fields.scaleRotateCenter == null) {
    const offset = fields.translation as readonly number[] | undefined;
    if (!offset || (offset[0] === 0 && offset[1] === 0)) return parent;
    const [a, b, c, d, x, y] = parent;
    return [a, b, c, d, a * offset[0] + c * offset[1] + x, b * offset[0] + d * offset[1] + y];
  }
  return multiplyAffine(parent, sceneAffine(fields));
}
export function affineBounds(matrix: Affine, width: number, height: number): LayoutRect {
  if (
    matrix[0] === 1 &&
    matrix[1] === 0 &&
    matrix[2] === 0 &&
    matrix[3] === 1 &&
    width >= 0 &&
    height >= 0
  ) {
    const x = matrix[4],
      y = matrix[5];
    return { x, y, width: x + width - x, height: y + height - y };
  }
  const points = [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ].map(([x, y]) => [
    matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5],
  ]);
  const left = Math.min(...points.map((point) => point[0])),
    top = Math.min(...points.map((point) => point[1]));
  return {
    x: left,
    y: top,
    width: Math.max(...points.map((point) => point[0])) - left,
    height: Math.max(...points.map((point) => point[1])) - top,
  };
}
export function inverseAffine(matrix: Affine): Affine | null {
  const [a, b, c, d, x, y] = matrix,
    determinant = a * d - b * c;
  if (Math.abs(determinant) < 1e-12) return null;
  return [
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * y - d * x) / determinant,
    (b * x - a * y) / determinant,
  ];
}
