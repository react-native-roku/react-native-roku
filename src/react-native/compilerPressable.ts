import type { ReactElement } from "react";
import type { LayoutStyle } from "../layout/flexLayout";
import type { NativePressableProps } from "./primitives";

const compilerStyles = new WeakSet<LayoutStyle>();
export type CompiledPressableKeys = readonly (keyof NativePressableProps)[];
const compilerProps = new WeakMap<object, CompiledPressableKeys>();

export function markPressableElement<T extends ReactElement>(
  element: T,
  keys: CompiledPressableKeys,
): T {
  compilerProps.set(element.props as object, keys);
  return element;
}
export function markPressableStyle<T extends LayoutStyle>(style: T): T {
  Object.freeze(style);
  compilerStyles.add(style);
  return style;
}
export function scalarPressableKeyOrder(props: object): CompiledPressableKeys | undefined {
  return compilerProps.get(props);
}
export function usesScalarPressableStyle(style: LayoutStyle): boolean {
  return compilerStyles.has(style);
}
