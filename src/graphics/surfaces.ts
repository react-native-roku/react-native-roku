import type { LayoutStyle } from "../layout/flexLayout";
import { RokuHostError } from "../scene/sceneGraph.types";
export interface NativeGraphics {
  readonly effects: boolean;
  /** The standalone hosts provide a bounded bitmap transport for composed masks. */
  readonly composedMasks?: boolean;
  /** Four alpha corner rasters in TL, TR, BR, BL order, generated from the same circle geometry. */
  readonly cornerMasks?: readonly [string, string, string, string];
}
const cornerFields = [
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomRightRadius",
  "borderBottomLeftRadius",
] as const;

export function hasRoundedCorners(style: LayoutStyle): boolean {
  let rounded = false;
  for (const field of cornerFields) {
    const value = style[field] ?? style.borderRadius ?? 0;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      throw new RokuHostError(
        "C03_ROUNDED_SURFACE",
        "Corner radii must be finite nonnegative numbers",
      );
    if (value > 0) rounded = true;
  }
  return rounded;
}
export function surfaceRadii(
  style: LayoutStyle,
  width: number,
  height: number,
): [number, number, number, number] {
  const radii = cornerFields.map((field) => {
    const value = style[field] ?? style.borderRadius ?? 0;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      throw new RokuHostError(
        "C03_ROUNDED_SURFACE",
        "Corner radii must be finite nonnegative numbers",
      );
    return value;
  });
  const factor = Math.min(
    1,
    ...[
      [width, radii[0] + radii[1]],
      [width, radii[2] + radii[3]],
      [height, radii[0] + radii[3]],
      [height, radii[1] + radii[2]],
    ].map(([limit, sum]) => (sum ? limit / sum : 1)),
  );
  return radii.map((radius) => radius * Math.max(0, factor)) as [number, number, number, number];
}

/** A single alpha surface clips the entire subtree in SceneGraph. */
export function roundedMask(style: LayoutStyle, width: number, height: number) {
  const radii = surfaceRadii(style, width, height);
  const bitmapWidth = Math.max(1, Math.min(2048, Math.ceil(width)));
  const bitmapHeight = Math.max(1, Math.min(2048, Math.ceil(height)));
  return {
    key: `rounded-mask:${width}:${height}:${radii.join(",")}`,
    width: bitmapWidth,
    height: bitmapHeight,
    pixels() {
      const pixels = new Uint8Array(bitmapWidth * bitmapHeight * 4).fill(255);
      const stepX = width / bitmapWidth,
        stepY = height / bitmapHeight;
      const aa = Math.hypot(stepX, stepY) / 2;
      radii.forEach((radius, corner) => {
        if (!radius || !aa) return;
        const right = corner === 1 || corner === 2;
        const bottom = corner >= 2;
        for (let y = 0; y < Math.min(bitmapHeight, Math.ceil(radius / stepY)); y++) {
          for (let x = 0; x < Math.min(bitmapWidth, Math.ceil(radius / stepX)); x++) {
            const edgeX = radius - (x + 0.5) * stepX;
            const edgeY = radius - (y + 0.5) * stepY;
            if (edgeX <= 0 || edgeY <= 0) continue;
            const coverage = (radius - Math.hypot(edgeX, edgeY) + aa) / (2 * aa);
            const row = bottom ? bitmapHeight - y - 1 : y;
            const column = right ? bitmapWidth - x - 1 : x;
            const alpha = (row * bitmapWidth + column) * 4 + 3;
            pixels[alpha] = Math.min(pixels[alpha], Math.round(255 * Math.max(0, coverage)));
          }
        }
      });
      return pixels;
    },
  };
}
export function uniformBorder(style: LayoutStyle): number {
  const width = style.borderWidth ?? 0;
  if (typeof width !== "number" || width < 0 || !Number.isFinite(width))
    throw new RokuHostError("C03_BORDER", "Border widths must be finite and nonnegative");
  for (const edge of ["Top", "Right", "Bottom", "Left"])
    if (
      (style[`border${edge}Width`] != null && style[`border${edge}Width`] !== width) ||
      (style[`border${edge}Color`] != null && style[`border${edge}Color`] !== style.borderColor)
    )
      throw new RokuHostError(
        "C03_ROUNDED_BORDER",
        "Asymmetric rounded borders need a per-edge paint adapter",
      );
  return width;
}
