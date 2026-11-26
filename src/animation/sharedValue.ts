import { RokuHostError } from "../scene/sceneGraph.types";
import { rokuColor } from "../react-native/styleSheet";
import { animationClock, type AnimationClock } from "./clock";

export type Animatable = number | string;
export type Animation =
  | {
      readonly kind: "timing";
      readonly to: Animatable;
      readonly duration: number;
      readonly easing: (value: number) => number;
      readonly callback?: (finished: boolean, value: Animatable) => void;
    }
  | {
      readonly kind: "delay";
      readonly duration: number;
      readonly animation: Animation;
    }
  | { readonly kind: "sequence"; readonly animations: readonly Animation[] }
  | {
      readonly kind: "repeat";
      readonly animation: Animation;
      readonly count: number;
      readonly reverse: boolean;
      readonly callback?: (finished: boolean) => void;
    };
export interface SharedValue<T> {
  get value(): T;
  set value(value: T | Animation);
  get(): T;
  set(value: T | Animation | ((previous: T) => T | Animation)): void;
  modify(modifier?: (value: T) => T): void;
  addListener(id: number, listener: (value: T) => void): void;
  removeListener(id: number): void;
}
export interface MutableValue<T> extends SharedValue<T> {
  readonly version: number;
  subscribe(listener: () => void): () => void;
  cancel(): void;
}
let collecting: Set<MutableValue<unknown>> | undefined;
export function collectValues<T>(work: () => T): {
  value: T;
  dependencies: Set<MutableValue<unknown>>;
} {
  const previous = collecting,
    dependencies = new Set<MutableValue<unknown>>();
  collecting = dependencies;
  try {
    return { value: work(), dependencies };
  } finally {
    collecting = previous;
  }
}
export function isAnimation(value: unknown): value is Animation {
  return (
    !!value &&
    typeof value === "object" &&
    "kind" in value &&
    ["timing", "delay", "sequence", "repeat"].includes(String(value.kind))
  );
}
function mix(from: Animatable, to: Animatable, progress: number): Animatable {
  if (progress >= 1) return to;
  if (typeof from === "number" && typeof to === "number") return from + (to - from) * progress;
  if (typeof from === "string" && typeof to === "string") {
    const left = /^(-?\d+(?:\.\d+)?)(%|px|deg|rad)?$/.exec(from),
      right = /^(-?\d+(?:\.\d+)?)(%|px|deg|rad)?$/.exec(to);
    if (left && right && left[2] === right[2])
      return `${Number(left[1]) + (Number(right[1]) - Number(left[1])) * progress}${left[2] ?? ""}`;
    try {
      const a = Number(rokuColor(from)),
        b = Number(rokuColor(to));
      let result = 0;
      for (const shift of [24, 16, 8, 0])
        result =
          result * 256 +
          Math.round(
            ((a >>> shift) & 255) + (((b >>> shift) & 255) - ((a >>> shift) & 255)) * progress,
          );
      return `#${result.toString(16).padStart(8, "0")}`;
    } catch {
      /* Report the actual unsupported interpolation below. */
    }
  }
  throw new RokuHostError(
    "C06_ANIMATION_VALUE",
    `Cannot interpolate ${String(from)} to ${String(to)}`,
  );
}
type Step = {
  duration: number;
  sample: (elapsed: number) => Animatable;
  finish?: (finished: boolean, value: Animatable) => void;
  target: Animatable;
};
function steps(animation: Animation, initial: Animatable): Step[] {
  if (animation.kind === "timing")
    return [
      {
        duration: animation.duration,
        sample: (elapsed) =>
          mix(
            initial,
            animation.to,
            animation.easing(animation.duration ? Math.min(1, elapsed / animation.duration) : 1),
          ),
        target: animation.to,
        finish: animation.callback,
      },
    ];
  if (animation.kind === "delay")
    return [
      { duration: animation.duration, sample: () => initial, target: initial },
      ...steps(animation.animation, initial),
    ];
  if (animation.kind === "sequence") {
    const result: Step[] = [];
    let current = initial;
    for (const child of animation.animations) {
      const next = steps(child, current);
      result.push(...next);
      if (next.length) current = next[next.length - 1].target;
    }
    return result;
  }
  // Repetitions are expanded one cycle at a time by the runner, keeping infinite loops bounded.
  return steps(animation.animation, initial);
}
export function makeMutable<T>(
  initial: T,
  clock: AnimationClock = animationClock,
): MutableValue<T> {
  let current = initial,
    version = 0,
    generation = 0,
    cancelRun: (() => void) | undefined;
  const listeners = new Set<() => void>(),
    identified = new Map<number, (value: T) => void>();
  const publish = (value: T) => {
    if (Object.is(current, value)) return;
    current = value;
    version++;
    const publication = version;
    for (const listener of [...listeners]) {
      if (version !== publication) return;
      listener();
    }
    for (const listener of [...identified.values()]) {
      if (version !== publication) return;
      listener(value);
    }
  };
  const mutable: MutableValue<T> = {
    get value(): T {
      collecting?.add(mutable as MutableValue<unknown>);
      return current;
    },
    set value(value: T | Animation) {
      const request = ++generation;
      const previous = cancelRun;
      cancelRun = undefined;
      previous?.();
      // Cancellation callbacks may synchronously admit a newer request. That
      // request owns the clock; the interrupted setter must not orphan it.
      if (request !== generation) return;
      if (!isAnimation(value)) {
        publish(value);
        return;
      }
      if (typeof current !== "string" && typeof current !== "number")
        throw new RokuHostError(
          "C06_ANIMATION_VALUE",
          "Animated values must be numbers, compatible unit strings, or colors",
        );
      const initialValue = current as Animatable,
        repeat = value.kind === "repeat" ? value : undefined;
      let plan = steps(value, initialValue),
        index = 0,
        cycle = 0,
        start = clock.now(),
        frame: unknown,
        canceled = false;
      if (!plan.length) {
        repeat?.callback?.(true);
        return;
      }
      const originalTarget = plan[plan.length - 1].target;
      const stop = () => {
        if (canceled) return;
        canceled = true;
        if (frame != null) clock.cancel(frame);
        plan[index]?.finish?.(false, current as Animatable);
        repeat?.callback?.(false);
      };
      cancelRun = stop;
      const tick = () => {
        if (canceled || request !== generation) return;
        const now = clock.now();
        // A blocked JS turn catches up to time rather than stretching the animation indefinitely.
        let transitions = 0;
        while (index < plan.length && now - start >= plan[index].duration) {
          const step = plan[index++];
          publish(step.target as T);
          step.finish?.(true, step.target);
          if (canceled) return;
          start += step.duration;
          if (
            index === plan.length &&
            repeat &&
            (++cycle, repeat.count <= 0 || cycle < repeat.count)
          ) {
            const target = repeat.reverse && cycle % 2 === 1 ? initialValue : originalTarget;
            const base = repeat.animation;
            if (repeat.reverse && base.kind !== "timing")
              throw new RokuHostError(
                "C06_ANIMATION_REPEAT",
                "Reverse repetition requires a timing animation",
              );
            if (!repeat.reverse) publish(initialValue as T);
            plan = steps(
              repeat.reverse
                ? {
                    ...(base as Extract<Animation, { kind: "timing" }>),
                    to: target,
                  }
                : base,
              current as Animatable,
            );
            index = 0;
          }
          if (++transitions > 10_000)
            throw new RokuHostError(
              "C06_ANIMATION_LOOP",
              "Zero-duration infinite animation cannot make progress",
            );
        }
        if (index === plan.length) {
          canceled = true;
          cancelRun = undefined;
          repeat?.callback?.(true);
          return;
        }
        const sample = plan[index].sample(now - start) as T;
        // A user easing function can replace/cancel this request while sampled.
        if (canceled || request !== generation) return;
        publish(sample);
        if (!canceled) frame = clock.request(tick);
      };
      tick();
    },
    get version() {
      return version;
    },
    get() {
      return mutable.value;
    },
    set(value) {
      mutable.value =
        typeof value === "function" ? (value as (previous: T) => T | Animation)(current) : value;
    },
    modify(modifier) {
      if (modifier) mutable.value = modifier(current);
    },
    addListener(id, listener) {
      identified.set(id, listener);
    },
    removeListener(id) {
      identified.delete(id);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    cancel() {
      generation++;
      const cancel = cancelRun;
      cancelRun = undefined;
      cancel?.();
    },
  };
  return mutable;
}
