import { createElement, createRef } from "react";
import { expect, it, vi } from "vitest";
import { createNativeRoot } from "./createNativeRoot";
import { View, Pressable } from "./primitives";
import { NativeInput } from "./NativeInput";
import type { NativeViewHandle } from "./nativeViewHandle";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
it("reflows siblings for an imperative spacer and yields to a later declarative size", async () => {
  const scene = new RecordingSceneGraph(),
    ref = createRef<NativeViewHandle>();
  const root = createNativeRoot(scene, {
    text: {
      prepare() {},
      metrics: () => ({ lineHeight: 20, width: () => 10 }),
    },
    viewport: { width: 800, height: 600 },
  });
  const render = (height: number) =>
    root.render(
      createElement(
        View,
        {},
        createElement(View, { ref, nativeID: "spacer", style: { height } }),
        createElement(View, {
          nativeID: "next",
          style: { width: 20, height: 20 },
        }),
      ),
    );
  try {
    render(10);
    await root.whenCommitted();
    ref.current!.setNativeProps({ style: { height: 40 } });
    await root.whenCommitted();
    expect(
      [...scene.nodes.values()].find((node) => node.fields.id === "next")?.fields.translation,
    ).toEqual([0, 40]);
    render(15);
    await root.whenCommitted();
    expect(
      [...scene.nodes.values()].find((node) => node.fields.id === "next")?.fields.translation,
    ).toEqual([0, 15]);
  } finally {
    root.unmount();
  }
  expect(scene.nodes.size).toBe(1);
});

it("retains TV activation when opacity and touch/accessibility presentation change imperatively", async () => {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput(),
    ref = createRef<NativeViewHandle>(),
    pressed = vi.fn();
  const root = createNativeRoot(scene, {
    input,
    text: {
      prepare() {},
      metrics: () => ({ lineHeight: 20, width: () => 10 }),
    },
    viewport: { width: 800, height: 600 },
  });
  try {
    root.render(
      createElement(
        View,
        { ref },
        createElement(Pressable, { nativeID: "action", onPress: pressed }, ""),
      ),
    );
    await root.whenCommitted();
    const button = [...scene.nodes.values()].find((node) => node.fields.id === "action")!;
    const select = () => {
      input.dispatch({ key: "select", phase: "down" });
      input.dispatch({ key: "select", phase: "up" });
    };
    scene.emit(button, "focusedChild", "action");
    select();
    expect(pressed).toHaveBeenCalledTimes(1);
    ref.current!.setNativeProps({
      pointerEvents: "none",
      accessibilityElementsHidden: true,
      style: { opacity: 0 },
    });
    await root.whenCommitted();
    select();
    expect(pressed).toHaveBeenCalledTimes(2);
    ref.current!.setNativeProps({
      pointerEvents: "auto",
      accessibilityElementsHidden: false,
      style: { opacity: 1 },
    });
    await root.whenCommitted();
    scene.emit(button, "focusedChild", "action");
    select();
    expect(pressed).toHaveBeenCalledTimes(3);
  } finally {
    root.unmount();
    input.dispose();
  }
  expect(scene.nodes.size).toBe(1);
  expect(scene.listenerCount).toBe(0);
});
