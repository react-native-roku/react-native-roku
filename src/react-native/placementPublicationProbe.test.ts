import { createElement as h, createRef } from "react";
import { expect, it, vi } from "vitest";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import { createNativeRoot } from "./createNativeRoot";
import { NativeInput } from "./NativeInput";
import { findNodeHandle, type NativeViewHandle } from "./nativeViewHandle";
import { Pressable, Text, View } from "./primitives";

it("publishes updated directional tags while retaining the committed layout", async () => {
  const scene = new RecordingSceneGraph();
  const input = new NativeInput();
  const far = createRef<NativeViewHandle>();
  const font = scene.create("font");
  const readHeight = vi.fn(() => 20);
  const text = {
    prepare() {},
    font: () => font,
    preparedFieldFont: () => font,
    readRetainedFontLineHeight: readHeight,
    metrics: () => ({ lineHeight: 20, width: (s: string) => s.length * 7 }),
  };
  const root = createNativeRoot(scene, {
    viewport: { width: 640, height: 360 },
    input,
    text,
  });
  const activated: string[] = [];
  const style = { width: 100, height: 48 };
  const render = async (nextFocusRight?: number) => {
    root.render(
      h(
        View,
        { style: { flexDirection: "row" } },
        h(
          Pressable,
          { nativeID: "first", style, nextFocusRight },
          h(Text, { style: { width: 90, height: 24 } }, nextFocusRight ? "Updated" : "Initial"),
        ),
        h(Pressable, { nativeID: "near", style, onPress: () => activated.push("near") }),
        h(Pressable, { nativeID: "far", style, ref: far, onPress: () => activated.push("far") }),
      ),
    );
    await root.whenCommitted();
  };
  const native = (id: string) => [...scene.nodes.values()].find((n) => n.fields.id === id)!;
  try {
    await render();
    const farTag = findNodeHandle(far.current)!;
    readHeight.mockClear();
    await render(farTag);
    expect(readHeight).toHaveBeenCalledExactlyOnceWith(font);
    scene.emit(native("first"), "focusedChild", "first");
    expect(input.dispatch({ key: "right", phase: "down" })).toBe(true);
    expect(native("far").fields.gainFocus).toBe(true);
    expect(native("near").fields.gainFocus).toBeUndefined();
    input.dispatch({ key: "select", phase: "down" });
    scene.emit(native("far"), "focusedChild", "far");
    input.dispatch({ key: "select", phase: "up" });
    expect(activated).toEqual(["far"]);
  } finally {
    root.unmount();
    input.dispose();
  }
});
