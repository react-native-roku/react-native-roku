import { createElement, useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeMutable } from "./sharedValue";
import {
  Easing,
  cancelAnimation,
  createAnimatedComponent,
  interpolate,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "./reanimated";
import { createNativeRoot } from "../react-native/createNativeRoot";
import { View } from "../react-native/primitives";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import type { AnimationClock } from "./clock";

class Clock implements AnimationClock {
  time = 0;
  sequence = 0;
  callbacks = new Map<number, () => void>();
  now() {
    return this.time;
  }
  request(callback: () => void) {
    const id = ++this.sequence;
    this.callbacks.set(id, callback);
    return id;
  }
  cancel(handle: unknown) {
    this.callbacks.delete(handle as number);
  }
  advance(time: number) {
    this.time = time;
    const pending = [...this.callbacks.values()];
    this.callbacks.clear();
    pending.forEach((callback) => callback());
  }
}
describe("SceneGraph JS animation execution", () => {
  afterEach(() => vi.useRealTimers());
  it("samples real elapsed time, cancels superseded animations, and reports completion exactly once", () => {
    const clock = new Clock(),
      value = makeMutable(0, clock),
      completions: unknown[] = [];
    value.value = withTiming(1, { duration: 100, easing: Easing.linear }, (finished, current) =>
      completions.push([finished, current]),
    );
    clock.advance(40);
    expect(value.value).toBeCloseTo(0.4);
    value.value = withTiming(0, { duration: 60, easing: Easing.linear }, (finished, current) =>
      completions.push([finished, current]),
    );
    expect(completions).toEqual([[false, 0.4]]);
    clock.advance(70);
    expect(value.value).toBeCloseTo(0.2);
    clock.advance(500);
    expect(value.value).toBe(0);
    expect(completions).toEqual([
      [false, 0.4],
      [true, 0],
    ]);
    expect(clock.callbacks.size).toBe(0);
  });
  it("lets a reentrant cancellation replacement own the only frame and retires it exactly once", () => {
    const clock = new Clock(),
      value = makeMutable(0, clock),
      first = vi.fn(),
      replacement = vi.fn();
    value.value = withTiming(1, { duration: 100, easing: Easing.linear }, (finished, current) => {
      first(finished, current);
      if (!finished)
        value.value = withTiming(3, { duration: 100, easing: Easing.linear }, replacement);
    });
    value.value = withTiming(2, { duration: 100, easing: Easing.linear });
    expect(first).toHaveBeenCalledExactlyOnceWith(false, 0);
    expect(clock.callbacks.size).toBe(1);
    clock.advance(50);
    expect(value.value).toBe(1.5);
    value.cancel();
    expect(replacement).toHaveBeenCalledExactlyOnceWith(false, 1.5);
    expect(clock.callbacks.size).toBe(0);
    clock.advance(200);
    expect(value.value).toBe(1.5);
  });
  it("cannot publish an old sample after an easing function admits a replacement", () => {
    const clock = new Clock(),
      value = makeMutable(0, clock);
    let replaced = false;
    value.value = withTiming(1, {
      duration: 100,
      easing: (progress) => {
        if (progress > 0 && !replaced) {
          replaced = true;
          value.value = withTiming(4, { duration: 100, easing: Easing.linear });
        }
        return progress;
      },
    });
    clock.advance(50);
    expect(value.value).toBe(0);
    expect(clock.callbacks.size).toBe(1);
    clock.advance(100);
    expect(value.value).toBe(2);
    value.cancel();
    expect(clock.callbacks.size).toBe(0);
  });
  it("does not deliver an obsolete publication after a subscriber synchronously replaces it", () => {
    const value = makeMutable(0),
      observed = vi.fn();
    const release = value.subscribe(() => {
      if (value.value === 1) value.value = 2;
    });
    value.addListener(1, observed);
    value.value = 1;
    expect(value.value).toBe(2);
    expect(observed).toHaveBeenCalledExactlyOnceWith(2);
    release();
    value.removeListener(1);
    value.value = 3;
    expect(observed).toHaveBeenCalledTimes(1);
  });
  it("handles delays, sequences, finite and infinite reversed repetition without accumulating frames", () => {
    const clock = new Clock(),
      value = makeMutable(0, clock),
      done = vi.fn();
    value.value = withSequence(
      withDelay(20, withTiming(1, { duration: 80, easing: Easing.linear })),
      withTiming(0, { duration: 100, easing: Easing.linear }),
    );
    clock.advance(10);
    expect(value.value).toBe(0);
    clock.advance(60);
    expect(value.value).toBeCloseTo(0.5);
    clock.advance(150);
    expect(value.value).toBeCloseTo(0.5);
    clock.advance(200);
    expect(value.value).toBe(0);
    value.value = withRepeat(
      withTiming(1, { duration: 100, easing: Easing.linear }),
      2,
      true,
      done,
    );
    clock.advance(350);
    expect(value.value).toBeCloseTo(0.5);
    clock.advance(400);
    expect(value.value).toBe(0);
    expect(done).toHaveBeenCalledExactlyOnceWith(true);
    value.value = withRepeat(withTiming(1, { duration: 100, easing: Easing.linear }), -1, true);
    for (let time = 450; time <= 1450; time += 50) {
      clock.advance(time);
      expect(clock.callbacks.size).toBe(1);
    }
    expect(value.value).toBeCloseTo(0.5);
    cancelAnimation(value);
    expect(clock.callbacks.size).toBe(0);
  });
  it("interpolates compatible dimensions and RGBA colors and preserves explicit extrapolation", () => {
    const clock = new Clock(),
      dimension = makeMutable("0%", clock),
      color = makeMutable("#00000000", clock);
    dimension.value = withTiming("100%", {
      duration: 100,
      easing: Easing.linear,
    });
    color.value = withTiming("#ffffffff", {
      duration: 100,
      easing: Easing.linear,
    });
    clock.advance(50);
    expect(dimension.value).toBe("50%");
    expect(color.value).toBe("#80808080");
    expect(interpolate(-1, [0, 1], [2, 4], "clamp")).toBe(2);
    expect(interpolate(2, [0, 1], [2, 4])).toBe(6);
    expect(Easing.bezier(0, 0, 1, 1)(0.3)).toBeCloseTo(0.3, 6);
    dimension.cancel();
    color.cancel();
  });
  it("reconciles committed React props and conditional shared dependencies across effect replay", async () => {
    const scene = new RecordingSceneGraph();
    const root = createNativeRoot(scene, {
      strictMode: true,
      viewport: { width: 800, height: 600 },
      text: { prepare() {}, metrics: () => ({ lineHeight: 20, width: () => 10 }) },
    });
    const first = makeMutable(0.25),
      second = makeMutable(0.4),
      gate = makeMutable(false);
    function Consumer({
      multiplier,
      chooseSecond = false,
    }: {
      multiplier: number;
      chooseSecond?: boolean;
    }) {
      const derived = useDerivedValue(
        () => (chooseSecond || gate.value ? second.value : first.value) * multiplier,
      );
      const style = useAnimatedStyle(() => ({ width: 100, height: 50, opacity: derived.value }));
      return createElement(View, { style });
    }
    const render = async (multiplier: number, chooseSecond = false) => {
      root.render(createElement(Consumer, { multiplier, chooseSecond }));
      await root.whenCommitted();
    };
    try {
      await render(1);
      expect(scene.root.children[0].fields.opacity).toBe(0.25);
      await render(2);
      expect(scene.root.children[0].fields.opacity).toBe(0.5);
      await render(2, true);
      expect(scene.root.children[0].fields.opacity).toBe(0.8);
      root.runSync(() => {
        first.value = 0.1;
      });
      expect(scene.root.children[0].fields.opacity).toBe(0.8);
      await render(2);
      expect(scene.root.children[0].fields.opacity).toBe(0.2);
      root.runSync(() => {
        gate.value = true;
      });
      expect(scene.root.children[0].fields.opacity).toBe(0.8);
      root.runSync(() => {
        first.value = 0.3;
        second.value = 0.2;
      });
      expect(scene.root.children[0].fields.opacity).toBe(0.4);
    } finally {
      root.unmount();
    }
    const retired = scene.operations.length;
    first.value = 0;
    second.value = 0;
    gate.value = false;
    expect(scene.operations.length).toBe(retired);
    expect(scene.nodes.size).toBe(1);
  });
  it("keeps inline timing clocks across render frames while using committed callbacks and canceling changed targets", async () => {
    vi.useFakeTimers();
    const scene = new RecordingSceneGraph();
    const root = createNativeRoot(scene, {
      strictMode: false,
      viewport: { width: 800, height: 600 },
      text: { prepare() {}, metrics: () => ({ lineHeight: 20, width: () => 10 }) },
    });
    const source = makeMutable(0),
      calls: Array<[string, boolean, number]> = [];
    function Consumer({ label, target = 1 }: { label: string; target?: number }) {
      const derived = useDerivedValue(() =>
        withTiming(
          source.value * target,
          {
            duration: 100,
            easing: (progress) => progress,
          },
          (finished, current) => calls.push([label, finished, Number(current)]),
        ),
      );
      const style = useAnimatedStyle(() => ({ width: 100, height: 50, opacity: derived.value }));
      return createElement(View, { style });
    }
    try {
      root.render(createElement(Consumer, { label: "old" }));
      await root.whenCommitted();
      root.runSync(() => {
        source.value = 1;
      });
      calls.length = 0;
      await vi.advanceTimersByTimeAsync(32);
      root.flush();
      await root.whenCommitted();
      expect(Number(scene.root.children[0].fields.opacity)).toBeGreaterThan(0);
      expect(Number(scene.root.children[0].fields.opacity)).toBeLessThan(1);
      root.render(createElement(Consumer, { label: "new" }));
      await root.whenCommitted();
      await vi.advanceTimersByTimeAsync(80);
      root.flush();
      await root.whenCommitted();
      expect(scene.root.children[0].fields.opacity).toBe(1);
      expect(calls).toEqual([["new", true, 1]]);
      root.render(createElement(Consumer, { label: "replacement", target: 0 }));
      await root.whenCommitted();
      await vi.advanceTimersByTimeAsync(48);
      root.flush();
      await root.whenCommitted();
      expect(Number(scene.root.children[0].fields.opacity)).toBeGreaterThan(0);
      expect(Number(scene.root.children[0].fields.opacity)).toBeLessThan(1);
    } finally {
      root.unmount();
    }
    expect(calls.at(-1)?.slice(0, 2)).toEqual(["replacement", false]);
    const retired = calls.length;
    source.value = 0;
    await vi.advanceTimersByTimeAsync(200);
    expect(calls.length).toBe(retired);
    expect(vi.getTimerCount()).toBe(0);
    expect(scene.nodes.size).toBe(1);
  });
  it("drives committed native styles through shared React hooks and stops all owned work on unmount", async () => {
    vi.useFakeTimers();
    const scene = new RecordingSceneGraph(),
      AnimatedView = createAnimatedComponent(View);
    const root = createNativeRoot(scene, {
      viewport: { width: 800, height: 600 },
      text: {
        prepare() {},
        metrics: () => ({ lineHeight: 20, width: () => 10 }),
      },
    });
    let presence: ReturnType<typeof makeMutable<number>>;
    function Consumer() {
      const source = useSharedValue(0);
      presence = source;
      const opacity = useDerivedValue(() =>
        withTiming(source.value, { duration: 100, easing: Easing.linear }),
      );
      const style = useAnimatedStyle(() => ({
        width: 100,
        height: 50,
        opacity: opacity.value,
      }));
      useEffect(() => {
        source.value = 1;
      }, [source]);
      return createElement(AnimatedView, { style });
    }
    root.render(createElement(Consumer));
    await root.whenCommitted();
    expect(scene.root.children[0].fields.opacity).toBe(0);
    await vi.advanceTimersByTimeAsync(48);
    root.flush();
    await root.whenCommitted();
    expect(Number(scene.root.children[0].fields.opacity)).toBeGreaterThan(0);
    expect(Number(scene.root.children[0].fields.opacity)).toBeLessThan(1);
    await vi.advanceTimersByTimeAsync(64);
    root.flush();
    await root.whenCommitted();
    expect(scene.root.children[0].fields.opacity).toBe(1);
    root.runSync(() => {
      presence!.value = 0;
    });
    await vi.advanceTimersByTimeAsync(16);
    root.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(scene.nodes.size).toBe(1);
  });
});
