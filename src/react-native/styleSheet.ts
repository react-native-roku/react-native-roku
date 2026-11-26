/// <reference path="../types/normalize-colors.d.ts" />
/// <reference path="../types/normalize-colors.d.ts" />
import type { LayoutStyle } from "../layout/flexLayout";
import { RokuHostError } from "../scene/sceneGraph.types";
import normalizeColor from "@react-native/normalize-colors";

export type NativeStyle = LayoutStyle | readonly NativeStyle[] | null | undefined | false | "" | 0;
export function flattenStyle(style: NativeStyle): LayoutStyle | undefined {
  if (!style) return undefined;
  if (Array.isArray(style)) return Object.assign({}, ...style.map((item) => flattenStyle(item)));
  if (typeof style !== "object")
    throw new RokuHostError(
      "C05_STYLE",
      "Registered numeric styles require a style registry adapter",
    );
  return style as LayoutStyle;
}

export const StyleSheet = {
  create<T extends Record<string, LayoutStyle>>(styles: T): T {
    return styles;
  },
  flatten: flattenStyle,
  compose(first: NativeStyle, second: NativeStyle): NativeStyle {
    return [first, second];
  },
  absoluteFill: Object.freeze({
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  }),
  absoluteFillObject: Object.freeze({
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  }),
  hairlineWidth: 1,
};

export function rokuColor(value: unknown): string {
  if (typeof value === "string" && /^0x[\da-f]{8}$/i.test(value)) return value;
  const normalized =
    typeof value === "string" || typeof value === "number" ? normalizeColor(value) : null;
  if (normalized == null)
    throw new RokuHostError(
      "C05_COLOR",
      `Color ${String(value)} requires an implemented color adapter`,
    );
  return `0x${(normalized >>> 0).toString(16).padStart(8, "0").toUpperCase()}`;
}
