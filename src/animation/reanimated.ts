import {
  createElement,
  forwardRef,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ComponentType,
} from "react";
import { View, Text } from "../react-native/primitives";
import { Image } from "../react-native/image";
import { ScrollView } from "../react-native/scrollView";
import { styleComponent } from "../react-native/styleInterop";
import { createDerivedMapper } from "./derivedValue";
import { RokuHostError } from "../scene/sceneGraph.types";
import {
  collectValues,
  makeMutable,
  type Animation,
  type Animatable,
  type MutableValue,
  type SharedValue,
} from "./sharedValue";
export { makeMutable };
export type { SharedValue };

export const Easing = Object.freeze({
  linear: (value: number) => value,
  ease: (value: number) => value * value * (3 - 2 * value),
  quad: (value: number) => value * value,
  cubic: (value: number) => value * value * value,
  in: (easing: (value: number) => number) => easing,
  out: (easing: (value: number) => number) => (value: number) => 1 - easing(1 - value),
  inOut: (easing: (value: number) => number) => (value: number) =>
    value < 0.5 ? easing(value * 2) / 2 : 1 - easing((1 - value) * 2) / 2,
  bezier(x1: number, y1: number, x2: number, y2: number) {
    if (![x1, y1, x2, y2].every(Number.isFinite) || x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1)
      throw new RokuHostError(
        "C06_EASING",
        "Bezier control points require finite values and x within [0,1]",
      );
    const sample = (t: number, a: number, b: number) =>
      3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
    return (value: number) => {
      if (value <= 0 || value >= 1) return Math.max(0, Math.min(1, value));
      let low = 0,
        high = 1;
      for (let i = 0; i < 24; i++) {
        const middle = (low + high) / 2;
        if (sample(middle, x1, x2) < value) low = middle;
        else high = middle;
      }
      return sample((low + high) / 2, y1, y2);
    };
  },
});
export function withTiming(
  to: Animatable,
  options: {
    duration?: number;
    easing?: (value: number) => number;
    reduceMotion?: unknown;
  } = {},
  callback?: (finished: boolean, current: Animatable) => void,
): Animation {
  const duration = options.duration ?? 300;
  if (!Number.isFinite(duration) || duration < 0)
    throw new RokuHostError("C06_DURATION", "Animation duration must be finite and nonnegative");
  return {
    kind: "timing",
    to,
    duration,
    easing: options.easing ?? Easing.inOut(Easing.quad),
    callback,
  };
}
export function withDelay(duration: number, animation: Animation): Animation {
  if (!Number.isFinite(duration) || duration < 0)
    throw new RokuHostError("C06_DURATION", "Animation delay must be finite and nonnegative");
  return { kind: "delay", duration, animation };
}
export function withSequence(...animations: Animation[]): Animation {
  return { kind: "sequence", animations };
}
export function withRepeat(
  animation: Animation,
  count = 2,
  reverse = false,
  callback?: (finished: boolean) => void,
): Animation {
  if (!Number.isInteger(count))
    throw new RokuHostError("C06_ANIMATION_REPEAT", "Repetition count must be an integer");
  return { kind: "repeat", animation, count, reverse, callback };
}
export function cancelAnimation(value: SharedValue<unknown>): void {
  (value as MutableValue<unknown>).cancel();
}

export function useSharedValue<T>(initial: T): MutableValue<T> {
  const value = useMemo(() => makeMutable(initial), []);
  useLayoutEffect(() => () => value.cancel(), [value]);
  return value;
}
function useReactive<T>(updater: () => T): T {
  const evaluation = collectValues(updater),
    dependencies = [...evaluation.dependencies];
  const subscribe = (callback: () => void) => {
    const releases = dependencies.map((value) => value.subscribe(callback));
    return () => releases.forEach((release) => release());
  };
  useSyncExternalStore(subscribe, () => dependencies.map((value) => value.version).join(":"));
  return evaluation.value;
}
export function useAnimatedStyle<T extends object>(
  updater: () => T,
  _dependencies?: readonly unknown[],
): T {
  return useReactive(updater);
}
export function useDerivedValue<T extends Animatable>(
  updater: () => T | Animation,
  _dependencies?: readonly unknown[],
): MutableValue<T> {
  const mapper = useMemo(() => createDerivedMapper(isTimingTarget(updater()) as T), []);
  useLayoutEffect(() => mapper.mount(), [mapper]);
  useLayoutEffect(() => mapper.commit(updater));
  return mapper.value;
}
function isTimingTarget(value: Animatable | Animation): Animatable {
  if (value && typeof value === "object" && "kind" in value) {
    const animation = value as Animation;
    if (animation.kind === "timing") return animation.to;
    if (animation.kind === "delay" || animation.kind === "repeat")
      return isTimingTarget(animation.animation);
    const last = animation.animations[animation.animations.length - 1];
    return last ? isTimingTarget(last) : 0;
  }
  return value as Animatable;
}
export function createAnimatedComponent<P extends object>(
  Component: ComponentType<P>,
): ComponentType<P> {
  // Animated styles subscribe through their hook; preserve refs and primitive identity here.
  const AnimatedComponent = forwardRef<unknown, P>((props, ref) =>
    createElement(styleComponent(Component), { ...props, ref } as P),
  );
  AnimatedComponent.displayName = `RokuAnimated(${Component.displayName ?? Component.name ?? "Component"})`;
  return AnimatedComponent as unknown as ComponentType<P>;
}
export interface AnimatedRef<T> {
  (value?: T | null): T | null;
  current: T | null;
}
export function useAnimatedRef<T>(): AnimatedRef<T> {
  return useMemo(() => {
    const callback = ((value?: T | null) => {
      if (value !== undefined) callback.current = value;
      return callback.current;
    }) as AnimatedRef<T>;
    callback.current = null;
    return callback;
  }, []);
}
export function useEvent<T>(
  handler: (event: T) => void,
  _events?: readonly string[],
  _rebuild?: boolean,
): (event: T | { nativeEvent: T }) => void {
  const latest = useRef(handler);
  latest.current = handler;
  return useMemo(
    () => (event) =>
      latest.current(
        event && typeof event === "object" && "nativeEvent" in event
          ? event.nativeEvent
          : (event as T),
      ),
    [],
  );
}
export function dispatchCommand(
  ref: { current?: unknown } | (() => unknown),
  command: string,
  args: unknown[] = [],
): void {
  const target = typeof ref === "function" ? ref() : ref.current;
  if (
    !target ||
    typeof target !== "object" ||
    typeof (target as Record<string, unknown>)[command] !== "function"
  )
    throw new RokuHostError(
      "C06_COMMAND",
      `Native command ${command} is unavailable on this target`,
    );
  (target as Record<string, (...args: unknown[]) => void>)[command](...args);
}
export function interpolate(
  value: number,
  input: readonly number[],
  output: readonly number[],
  extrapolate:
    | "clamp"
    | "extend"
    | "identity"
    | { extrapolateLeft?: string; extrapolateRight?: string } = "extend",
): number {
  if (
    input.length < 2 ||
    input.length !== output.length ||
    input.some((item, index) => !Number.isFinite(item) || (index > 0 && item <= input[index - 1]))
  )
    throw new RokuHostError(
      "C06_INTERPOLATE",
      "Interpolation ranges must have matching length and increasing finite input",
    );
  const left =
      typeof extrapolate === "string" ? extrapolate : (extrapolate.extrapolateLeft ?? "extend"),
    right =
      typeof extrapolate === "string" ? extrapolate : (extrapolate.extrapolateRight ?? "extend");
  if (value < input[0]) {
    if (left === "clamp") return output[0];
    if (left === "identity") return value;
  }
  if (value > input[input.length - 1]) {
    if (right === "clamp") return output[output.length - 1];
    if (right === "identity") return value;
  }
  let segment = 0;
  while (segment < input.length - 2 && value > input[segment + 1]) segment++;
  return (
    output[segment] +
    ((value - input[segment]) / (input[segment + 1] - input[segment])) *
      (output[segment + 1] - output[segment])
  );
}
export default Object.freeze({
  createAnimatedComponent,
  View: createAnimatedComponent(View),
  Text: createAnimatedComponent(Text),
  Image: createAnimatedComponent(Image),
  ScrollView: createAnimatedComponent(ScrollView),
});
