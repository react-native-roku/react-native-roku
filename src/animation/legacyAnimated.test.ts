import { createElement, useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Animated, Easing } from "./legacyAnimated";
import { createNativeRoot } from "../react-native/createNativeRoot";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
afterEach(() => vi.useRealTimers());

it("commits legacy animated arithmetic and cancels completion on owner retirement", async () => {
  vi.useFakeTimers();
  const scene = new RecordingSceneGraph(),
    value = new Animated.Value(0),
    completed = vi.fn();
  const root = createNativeRoot(scene, {
    viewport: { width: 800, height: 600 },
    text: {
      prepare() {},
      metrics: () => ({ lineHeight: 20, width: () => 10 }),
    },
  });
  function Owner() {
    useEffect(() => {
      const animation = Animated.timing(value, {
        toValue: 100,
        duration: 100,
        easing: Easing.linear,
      });
      animation.start(completed);
      return () => animation.stop();
    }, []);
    return createElement(Animated.View, {
      style: {
        width: 100,
        height: 50,
        transform: [{ translateX: Animated.multiply(value, -1) }],
      },
    });
  }
  root.render(createElement(Owner));
  await root.whenCommitted();
  await vi.advanceTimersByTimeAsync(48);
  root.flush();
  await root.whenCommitted();
  expect((scene.root.children[0].fields.translation as number[])[0]).toBeCloseTo(-48);
  root.unmount();
  expect(completed).toHaveBeenCalledExactlyOnceWith({ finished: false });
  expect(vi.getTimerCount()).toBe(0);
  expect(scene.nodes.size).toBe(1);
});

it("maps event values and preserves offset listeners and sequence completion", async () => {
  vi.useFakeTimers();
  const value = new Animated.Value(1),
    listener = vi.fn(),
    done = vi.fn();
  const id = value.addListener(listener);
  value.setOffset(4);
  Animated.event([{ nativeEvent: { translation: value } }])({
    nativeEvent: { translation: 3 },
  });
  expect(value.__getValue()).toBe(7);
  value.flattenOffset();
  expect(value.__getValue()).toBe(7);
  value.removeListener(id);
  listener.mockClear();
  Animated.sequence([
    Animated.timing(value, { toValue: 2, duration: 32 }),
    Animated.timing(value, { toValue: 5, duration: 32 }),
  ]).start(done);
  await vi.advanceTimersByTimeAsync(80);
  expect(value.__getValue()).toBe(5);
  expect(done).toHaveBeenCalledExactlyOnceWith({ finished: true });
  expect(listener).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
