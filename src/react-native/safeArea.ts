import { createContext, createElement, forwardRef, useContext, type ReactNode } from "react";
import { useNativeHost } from "./nativeHostContext";
import { View } from "./primitives";
import { flattenStyle, type NativeStyle } from "./styleSheet";
import type { NativeViewHandle } from "./nativeViewHandle";
import { RokuHostError } from "../scene/sceneGraph.types";

interface Insets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}
interface Frame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
const ZERO = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });
export const SafeAreaInsetsContext = createContext<Insets | null>(null);
export const SafeAreaFrameContext = createContext<Frame | null>(null);
export const initialWindowMetrics = null;

export function SafeAreaProvider({
  children,
  initialMetrics,
}: {
  readonly children?: ReactNode;
  readonly initialMetrics?: { insets: Insets; frame: Frame } | null;
}) {
  const host = useNativeHost();
  const insets = initialMetrics?.insets ?? ZERO,
    frame = initialMetrics?.frame ?? { x: 0, y: 0, ...host.viewport };
  for (const value of Object.values(insets))
    if (!Number.isFinite(value) || value < 0)
      throw new RokuHostError("C03_SAFE_AREA", "Insets must be finite and nonnegative");
  return createElement(
    SafeAreaInsetsContext.Provider,
    { value: insets },
    createElement(SafeAreaFrameContext.Provider, { value: frame }, children),
  );
}
export function useSafeAreaInsets(): Insets {
  return useContext(SafeAreaInsetsContext) ?? ZERO;
}
export function useSafeAreaFrame(): Frame {
  const host = useNativeHost();
  return useContext(SafeAreaFrameContext) ?? { x: 0, y: 0, ...host.viewport };
}
export const SafeAreaView = forwardRef<
  NativeViewHandle,
  {
    readonly children?: ReactNode;
    readonly style?: NativeStyle;
    readonly edges?: readonly (keyof Insets)[];
  }
>((props, ref) => {
  const insets = useSafeAreaInsets(),
    style = flattenStyle(props.style) ?? {},
    padding: Record<string, number> = {};
  for (const edge of props.edges ?? ["top", "right", "bottom", "left"]) {
    if (!insets[edge]) continue;
    const name = `padding${edge[0].toUpperCase()}${edge.slice(1)}`;
    const current =
      style[name] ??
      style[edge === "top" || edge === "bottom" ? "paddingVertical" : "paddingHorizontal"] ??
      style.padding ??
      0;
    if (typeof current !== "number")
      throw new RokuHostError("C03_SAFE_AREA", "Nonzero insets require numeric padding");
    padding[name] = current + insets[edge];
  }
  return createElement(View, { ref, style: [style, padding] }, props.children);
});
SafeAreaView.displayName = "RokuSafeAreaView";
