import { createElement, useLayoutEffect } from "react";
import { View, type NativeElementProps } from "./primitives";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "../animation/reanimated";
import { RokuHostError } from "../scene/sceneGraph.types";
import { styleComponent } from "./styleInterop";
export interface ActivityIndicatorProps extends NativeElementProps {
  readonly animating?: boolean;
  readonly hidesWhenStopped?: boolean;
  readonly color?: string;
  readonly size?: "small" | "large" | number;
}
/** Timed JS spinner with one owned animation; no decoder or native-thread progress claim. */
export function ActivityIndicator({
  animating = true,
  hidesWhenStopped = true,
  color = "#999999",
  size = "small",
  style,
  ...props
}: ActivityIndicatorProps) {
  const extent = typeof size === "number" ? size : size === "large" ? 36 : 20;
  if (!Number.isFinite(extent) || extent <= 0 || extent > 512)
    throw new RokuHostError("C03_SPINNER_SIZE", "ActivityIndicator size must be within (0,512]");
  const phase = useSharedValue(0);
  useLayoutEffect(() => {
    if (animating)
      phase.value = withRepeat(withTiming(360, { duration: 900, easing: Easing.linear }), -1);
    else phase.value = 0;
    return () => phase.cancel();
  }, [animating, phase]);
  const rotation = useAnimatedStyle(() => ({
    width: extent,
    height: extent,
    transform: [{ rotate: `${phase.value}deg` }],
  }));
  return createElement(
    styleComponent(View),
    {
      ...props,
      style: [{ alignItems: "center", justifyContent: "center" }, style],
    },
    animating || !hidesWhenStopped
      ? createElement(
          Animated.View,
          { style: rotation },
          ...Array.from({ length: 12 }, (_, index) => {
            const angle = (index * Math.PI) / 6,
              radius = extent * 0.34;
            return createElement(View, {
              key: index,
              style: {
                position: "absolute",
                width: extent / 12,
                height: extent / 4,
                left: extent / 2 + Math.sin(angle) * radius - extent / 24,
                top: extent / 2 - Math.cos(angle) * radius - extent / 8,
                backgroundColor: color,
                opacity: (index + 1) / 12,
                transform: [{ rotate: `${index * 30}deg` }],
              },
            });
          }),
        )
      : null,
  );
}
