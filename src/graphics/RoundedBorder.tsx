import { createElement, useId, useState } from "react";
import { BitmapLayer } from "./BitmapLayer";
import { surfaceRadii } from "./surfaces";
import type { LayoutStyle } from "../layout/flexLayout";
import type { Point } from "../vector/svgPath";
import { svgPixels } from "../vector/svgPixels";
import { rokuColor } from "../react-native/styleSheet";
import { RokuHostError } from "../scene/sceneGraph.types";
const edges = ["Top", "Right", "Bottom", "Left"] as const;
function rounded(
  x: number,
  y: number,
  width: number,
  height: number,
  radii: readonly (readonly [number, number])[],
): Point[] {
  const centers = [
    [x + width - radii[1][0], y + radii[1][1]],
    [x + width - radii[2][0], y + height - radii[2][1]],
    [x + radii[3][0], y + height - radii[3][1]],
    [x + radii[0][0], y + radii[0][1]],
  ];
  const order = [1, 2, 3, 0];
  const points = centers.flatMap(([cx, cy], i) =>
    Array.from({ length: 17 }, (_, n) => {
      const angle = ((-1 + i) * Math.PI) / 2 + (n * Math.PI) / 32,
        [rx, ry] = radii[order[i]];
      return [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)] as Point;
    }),
  );
  return [...points, points[0]];
}
export function roundedBorderPixels(style: LayoutStyle, width: number, height: number) {
  const borders = edges.map((edge) =>
    Number(style[`border${edge}Width`] ?? style.borderWidth ?? 0),
  );
  if (borders.some((value) => !Number.isFinite(value) || value < 0))
    throw new RokuHostError("C03_BORDER", "Border widths must be finite and nonnegative");
  const colors = edges
    .filter((_, index) => borders[index] > 0)
    .map((edge) => String(style[`border${edge}Color`] ?? style.borderColor ?? "black"));
  if (new Set(colors.map(rokuColor)).size > 1)
    throw new RokuHostError(
      "C03_ROUNDED_BORDER",
      "Multicolor asymmetric rounded borders need a paint adapter",
    );
  const radii = surfaceRadii(style, width, height),
    [top, right, bottom, left] = borders;
  const outer = rounded(
    0,
    0,
    width,
    height,
    radii.map((radius) => [radius, radius] as const),
  );
  const inner =
    width > left + right && height > top + bottom
      ? rounded(
          left,
          top,
          width - left - right,
          height - top - bottom,
          radii.map(
            (radius, index) =>
              [
                Math.max(0, radius - (index === 0 || index === 3 ? left : right)),
                Math.max(0, radius - (index < 2 ? top : bottom)),
              ] as const,
          ),
        ).reverse()
      : [];
  return svgPixels(Math.ceil(width), Math.ceil(height), [
    {
      paths: [outer, ...(inner.length ? [inner] : [])],
      fill: colors[0] ?? "transparent",
    },
  ]);
}
export function RoundedBorder({ style }: { style: LayoutStyle }) {
  const id = useId(),
    [size, setSize] = useState<{ width: number; height: number }>();
  const identity = JSON.stringify({
    style: Object.fromEntries(Object.entries(style).filter(([key]) => key.startsWith("border"))),
    size,
  });
  return createElement(
    "group",
    {
      layout: {
        id,
        decoration: "background",
        onLayout(event: unknown) {
          const value = (
            event as {
              nativeEvent: { layout: { width: number; height: number } };
            }
          ).nativeEvent.layout;
          if (value.width > 0 && value.height > 0)
            setSize((previous) =>
              previous?.width === value.width && previous.height === value.height
                ? previous
                : { width: value.width, height: value.height },
            );
        },
      },
    },
    size
      ? createElement(BitmapLayer, {
          identity,
          width: Math.ceil(size.width),
          height: Math.ceil(size.height),
          pixels: () => roundedBorderPixels(style, size.width, size.height),
        })
      : null,
  );
}
