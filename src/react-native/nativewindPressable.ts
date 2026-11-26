import { createElement, forwardRef, useRef, useState, type ComponentType } from "react";
import type { NativePressableProps } from "./primitives";
import type { NativeViewHandle } from "./nativeViewHandle";

/** Evaluate callback styles before the pinned interop engine resolves class and inline precedence. */
export function withPressableStyleCallbacks(Interop: ComponentType<NativePressableProps>) {
  const CallbackStyles = forwardRef<NativeViewHandle, NativePressableProps>((props, ref) => {
    const state = useRef({ pressed: false, focused: false, hovered: false }),
      [, invalidate] = useState(0);
    const publish = (next: Partial<typeof state.current>) => {
      state.current = { ...state.current, ...next };
      if (typeof props.style === "function") invalidate((value) => value + 1);
    };
    return createElement(Interop, {
      ...props,
      ref,
      style: typeof props.style === "function" ? props.style(state.current) : props.style,
      onFocus: (event) => {
        publish({ focused: true });
        props.onFocus?.(event);
      },
      onBlur: (event) => {
        publish({ focused: false, pressed: false });
        props.onBlur?.(event);
      },
      onPressIn: (event) => {
        publish({ pressed: true });
        props.onPressIn?.(event);
      },
      onPressOut: (event) => {
        publish({ pressed: false });
        props.onPressOut?.(event);
      },
    } as NativePressableProps);
  });
  CallbackStyles.displayName = "RokuNativeWindPressable";
  return CallbackStyles;
}
