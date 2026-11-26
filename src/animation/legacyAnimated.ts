import { createElement, forwardRef, type ComponentType } from "react";
import { makeMutable, type MutableValue } from "./sharedValue";
import { Easing, interpolate, useAnimatedStyle, withTiming } from "./reanimated";
import { View, Text } from "../react-native/primitives";
import { Image } from "../react-native/image";
import { ScrollView } from "../react-native/scrollView";
import { styleComponent } from "../react-native/styleInterop";
import { RokuHostError } from "../scene/sceneGraph.types";
export { Easing };
let listenerID = 0,
  warned = false;
class AnimatedNode {
  constructor(readonly read: () => number) {}
  interpolate(config: {
    inputRange: number[];
    outputRange: number[];
    extrapolate?: "extend" | "clamp" | "identity";
  }) {
    return new AnimatedNode(() =>
      interpolate(this.read(), config.inputRange, config.outputRange, config.extrapolate),
    );
  }
  __getValue(): number {
    return this.read();
  }
}
export class Value extends AnimatedNode {
  readonly mutable: MutableValue<number>;
  private readonly offset: MutableValue<number>;
  private readonly listenerIDs = new Set<number>();
  constructor(initial: number) {
    const value = makeMutable(initial),
      offset = makeMutable(0);
    super(() => value.value + offset.value);
    this.mutable = value;
    this.offset = offset;
  }
  setValue(value: number): void {
    this.mutable.value = value;
  }
  setOffset(value: number): void {
    this.offset.value = value;
  }
  flattenOffset(): void {
    this.mutable.value += this.offset.value;
    this.offset.value = 0;
  }
  extractOffset(): void {
    this.offset.value += this.mutable.value;
    this.mutable.value = 0;
  }
  stopAnimation(callback?: (value: number) => void): void {
    this.mutable.cancel();
    callback?.(this.read());
  }
  addListener(callback: (event: { value: number }) => void): string {
    const id = ++listenerID;
    this.listenerIDs.add(id);
    const listener = () => callback({ value: this.read() });
    this.mutable.addListener(id, listener);
    this.offset.addListener(id, listener);
    return String(id);
  }
  removeListener(id: string): void {
    this.mutable.removeListener(Number(id));
    this.offset.removeListener(Number(id));
    this.listenerIDs.delete(Number(id));
  }
  removeAllListeners(): void {
    for (const id of this.listenerIDs) this.removeListener(String(id));
  }
}
function resolve(value: unknown): unknown {
  if (value instanceof AnimatedNode) return value.read();
  if (Array.isArray(value)) return value.map(resolve);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
  return value;
}
function createAnimatedComponent<P extends object>(Component: ComponentType<P>) {
  return forwardRef<unknown, P & { style?: unknown }>((props, ref) => {
    const style = useAnimatedStyle(() => resolve(props.style) as object);
    return createElement(styleComponent(Component), {
      ...props,
      style,
      ref,
    } as P);
  });
}
export interface CompositeAnimation {
  start(callback?: (result: { finished: boolean }) => void): void;
  stop(): void;
  reset(): void;
}
function timing(
  value: Value,
  config: {
    toValue: number;
    duration?: number;
    easing?: (value: number) => number;
    useNativeDriver?: boolean;
  },
): CompositeAnimation {
  let initial = value.mutable.value;
  return {
    start(callback) {
      initial = value.mutable.value;
      if (config.useNativeDriver && !warned) {
        warned = true;
        console.warn(
          "RNR_JS_ANIMATION_DRIVER",
          "Native-thread animation performance is not qualified; using the Roku JS executor",
        );
      }
      value.mutable.value = withTiming(config.toValue, config, (finished) =>
        callback?.({ finished }),
      );
    },
    stop() {
      value.stopAnimation();
    },
    reset() {
      value.stopAnimation();
      value.setValue(initial);
    },
  };
}
function parallel(
  animations: CompositeAnimation[],
  options: { stopTogether?: boolean } = {},
): CompositeAnimation {
  let active = false,
    remaining = 0,
    finished = true,
    callback: ((result: { finished: boolean }) => void) | undefined;
  const complete = (result: { finished: boolean }) => {
    if (!active) return;
    finished &&= result.finished;
    if (!result.finished && options.stopTogether !== false) {
      active = false;
      animations.forEach((animation) => animation.stop());
      callback?.({ finished: false });
      return;
    }
    if (--remaining === 0) {
      active = false;
      callback?.({ finished });
    }
  };
  return {
    start(next) {
      active = true;
      remaining = animations.length;
      finished = true;
      callback = next;
      if (!remaining) {
        active = false;
        next?.({ finished: true });
      } else
        animations.forEach((animation) => {
          if (active) animation.start(complete);
        });
    },
    stop() {
      if (!active) return;
      active = false;
      animations.forEach((animation) => animation.stop());
      callback?.({ finished: false });
    },
    reset() {
      active = false;
      animations.forEach((animation) => animation.reset());
    },
  };
}
function sequence(animations: CompositeAnimation[]): CompositeAnimation {
  let index = 0,
    active = false,
    callback: ((result: { finished: boolean }) => void) | undefined;
  const next = (result: { finished: boolean }) => {
    if (!active) return;
    if (!result.finished || index === animations.length) {
      active = false;
      callback?.(result);
      return;
    }
    animations[index++].start(next);
  };
  return {
    start(done) {
      index = 0;
      active = true;
      callback = done;
      next({ finished: true });
    },
    stop() {
      if (!active) return;
      active = false;
      animations[index - 1]?.stop();
      callback?.({ finished: false });
    },
    reset() {
      active = false;
      animations.forEach((animation) => animation.reset());
    },
  };
}
const read = (value: AnimatedNode | number) =>
  value instanceof AnimatedNode ? value.read() : value;
const binary = (
  left: AnimatedNode | number,
  right: AnimatedNode | number,
  operation: (a: number, b: number) => number,
) => new AnimatedNode(() => operation(read(left), read(right)));
function event(mapping: unknown[], options: { listener?: (...args: unknown[]) => void } = {}) {
  const assign = (map: unknown, value: unknown): void => {
    if (map instanceof Value) {
      if (typeof value !== "number")
        throw new RokuHostError("C06_ANIMATED_EVENT", "Animated event values must be numeric");
      map.setValue(value);
    } else if (map && typeof map === "object")
      for (const [key, child] of Object.entries(map))
        assign(child, (value as Record<string, unknown> | null)?.[key]);
  };
  return (...values: unknown[]) => {
    mapping.forEach((map, index) => assign(map, values[index]));
    options.listener?.(...values);
  };
}
const pending = (): never => {
  throw new RokuHostError("C06_ANIMATION", "This legacy animation recipe needs a Roku executor");
};
export const Animated = Object.freeze({
  Value,
  createAnimatedComponent,
  View: createAnimatedComponent(View),
  Text: createAnimatedComponent(Text),
  Image: createAnimatedComponent(Image),
  ScrollView: createAnimatedComponent(ScrollView),
  timing,
  parallel,
  sequence,
  event,
  add: (a: AnimatedNode | number, b: AnimatedNode | number) => binary(a, b, (x, y) => x + y),
  subtract: (a: AnimatedNode | number, b: AnimatedNode | number) => binary(a, b, (x, y) => x - y),
  multiply: (a: AnimatedNode | number, b: AnimatedNode | number) => binary(a, b, (x, y) => x * y),
  divide: (a: AnimatedNode | number, b: AnimatedNode | number) =>
    binary(a, b, (x, y) => {
      if (!y) throw new RokuHostError("C06_ANIMATION_VALUE", "Animated division by zero");
      return x / y;
    }),
  spring: pending,
  decay: pending,
  loop: pending,
});
