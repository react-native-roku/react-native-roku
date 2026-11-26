import { createElement, forwardRef, Fragment } from "react";
import { background, SurfaceClip, useElement, type NativeElementProps } from "./primitives";
import { useNativeHost } from "./nativeHostContext";
import type { NativeViewHandle } from "./nativeViewHandle";
import { hasRoundedCorners, uniformBorder } from "../graphics/surfaces";
import { rokuColor } from "./styleSheet";
import { RokuHostError } from "../scene/sceneGraph.types";
export interface LinearGradientProps extends NativeElementProps {
  readonly colors: readonly unknown[];
  readonly locations?: readonly number[];
  readonly start?: { x: number; y: number };
  readonly end?: { x: number; y: number };
  readonly dither?: boolean;
}
export const LinearGradient = forwardRef<NativeViewHandle, LinearGradientProps>((props, ref) => {
  const host = useNativeHost(),
    element = useElement(props, ref);
  if (!host.graphics?.effects)
    throw new RokuHostError("C03_GRADIENT", "Gradients require the OS 16 OpenGL Effect capability");
  if (
    props.colors.length < 2 ||
    props.colors.length > 8 ||
    (props.locations && props.locations.length !== props.colors.length)
  )
    throw new RokuHostError(
      "C03_GRADIENT",
      "Native gradients require 2..8 colors and matching stops",
    );
  if (props.dither === false)
    throw new RokuHostError(
      "C03_GRADIENT_DITHER",
      "The native Effect does not expose a dither switch",
    );
  const border = uniformBorder(element.style),
    rounded = hasRoundedCorners(element.style);
  return createElement(
    "group",
    { fields: element.fields, layout: element.layout },
    createElement(
      Fragment,
      { key: "base" },
      element.style.backgroundColor == null
        ? null
        : background(
            {
              ...element.style,
              borderWidth: 0,
              borderTopWidth: 0,
              borderRightWidth: 0,
              borderBottomWidth: 0,
              borderLeftWidth: 0,
            },
            host.graphics,
          ),
    ),
    createElement(
      "rectangle",
      {
        // The native Effect composites its stops over the Rectangle color.
        fields: { color: "0x00000000" },
        layout: { decoration: "background" },
      },
      createElement("effect", {
        fields: {
          borderWidth: 0,
          gradientStyle: "linear",
          gradientColors: props.colors.map(rokuColor),
        },
        layout: {
          resource: true,
          radiusStyle: element.style,
          insetBorder: 0,
          gradient: {
            start: props.start ?? { x: 0.5, y: 0 },
            end: props.end ?? { x: 0.5, y: 1 },
            locations:
              props.locations ?? props.colors.map((_, index) => index / (props.colors.length - 1)),
          },
        },
      }),
    ),
    border
      ? createElement(
          Fragment,
          { key: "border" },
          ...background({ ...element.style, backgroundColor: undefined }, host.graphics),
        )
      : null,
    rounded && element.style.overflow === "hidden"
      ? createElement(SurfaceClip, { style: element.style }, props.children)
      : props.children,
  );
});
LinearGradient.displayName = "RokuLinearGradient";
