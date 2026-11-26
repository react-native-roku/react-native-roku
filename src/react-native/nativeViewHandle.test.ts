import { createElement, createRef, StrictMode, useLayoutEffect, useRef } from "react";
import { expect, it } from "vitest";
import { createNativeRoot } from "./createNativeRoot";
import { NativeInput } from "./NativeInput";
import { Pressable, Text, View } from "./primitives";
import { findNodeHandle, type NativeViewHandle } from "./nativeViewHandle";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import { AccessibilityInfo } from "./environment";
import { TextInput, type NativeTextInputHandle } from "./textInput";

it("routes object and numeric accessibility focus to their owning root, never the latest root", async () => {
  const firstScene = new RecordingSceneGraph(),
    secondScene = new RecordingSceneGraph(),
    firstInput = new NativeInput(),
    secondInput = new NativeInput(),
    ref = createRef<NativeViewHandle>();
  const first = createNativeRoot(firstScene, {
    input: firstInput,
    text,
    viewport: { width: 800, height: 600 },
  });
  first.render(createElement(Pressable, { ref, nativeID: "first" }));
  await first.whenCommitted();
  const second = createNativeRoot(secondScene, {
    input: secondInput,
    text,
    viewport: { width: 800, height: 600 },
  });
  try {
    second.render(createElement(Pressable, { nativeID: "second" }));
    await second.whenCommitted();
    AccessibilityInfo.setAccessibilityFocus(findNodeHandle(ref.current)!);
    expect(
      [...firstScene.nodes.values()].find((node) => node.fields.id === "first")?.fields.gainFocus,
    ).toBe(true);
    const before = firstScene.operations.length;
    AccessibilityInfo.sendAccessibilityEvent(ref.current!, "focus");
    expect(firstScene.operations.length).toBeGreaterThan(before);
    expect(secondScene.operations.filter((operation) => operation.field === "gainFocus")).toEqual(
      [],
    );
    expect(firstInput.focusedID).toBe(null);
    expect(secondInput.focusedID).toBe(null);
  } finally {
    // Out-of-order retirement must not invalidate the remaining root.
    first.unmount();
    second.unmount();
    firstInput.dispose();
    secondInput.dispose();
  }
});

it("object accessibility focus honors hidden ancestry, replacement and retirement without activating controls", async () => {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput(),
    ref = createRef<NativeViewHandle>();
  const root = createNativeRoot(scene, { input, text, viewport: { width: 800, height: 600 } });
  let presses = 0;
  try {
    root.render(
      createElement(
        View,
        { "aria-hidden": true },
        createElement(Pressable, { ref, nativeID: "same", onPress: () => presses++ }),
      ),
    );
    await root.whenCommitted();
    AccessibilityInfo.sendAccessibilityEvent(ref.current!, "focus");
    await root.whenCommitted();
    expect(scene.operations.filter((operation) => operation.field === "gainFocus")).toEqual([]);
    const old = ref.current!;
    root.render(createElement(Pressable, { ref, nativeID: "same", onPress: () => presses++ }));
    await root.whenCommitted();
    const before = scene.operations.length;
    AccessibilityInfo.sendAccessibilityEvent(old, "focus");
    expect(scene.operations.length).toBe(before);
    AccessibilityInfo.sendAccessibilityEvent(ref.current!, "focus");
    expect(
      [...scene.nodes.values()].find((node) => node.fields.id === "same")?.fields.gainFocus,
    ).toBe(true);
    expect(() => AccessibilityInfo.sendAccessibilityEvent(ref.current!, "click" as never)).toThrow(
      "Only the focus accessibility event is supported",
    );
    expect(presses).toBe(0);
    const retained = ref.current!;
    root.unmount();
    expect(() => AccessibilityInfo.sendAccessibilityEvent(retained, "focus")).not.toThrow();
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
  } finally {
    root.unmount();
    input.dispose();
  }
});

it("resolves a stable TextInput host alias without opening its keyboard or bypassing focus admission", async () => {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput(),
    ref = createRef<NativeTextInputHandle>();
  let opened = 0;
  const root = createNativeRoot(scene, {
    input,
    text,
    viewport: { width: 800, height: 600 },
    services: {
      storage: { read: async () => null, write: async () => {} },
      randomUUID: () => "fixture",
      randomBytes: (length) => new Uint8Array(length),
      textEntry: {
        open: () => {
          opened++;
          return { result: new Promise(() => {}), close() {} };
        },
      },
    },
  });
  try {
    root.render(createElement(TextInput, { ref, nativeID: "entry", value: "private" }));
    await root.whenCommitted();
    const handle = ref.current!;
    expect(findNodeHandle(handle)).toBeGreaterThan(0);
    const before = scene.operations.length;
    AccessibilityInfo.sendAccessibilityEvent(handle, "focus");
    expect(opened).toBe(0);
    expect(input.focusedID).toBe(null);
    expect(
      scene.operations
        .slice(before)
        .filter((operation) => operation.operation === "set" && operation.field === "gainFocus"),
    ).toEqual([]);
    root.render(createElement(TextInput, { ref, nativeID: "renamed", value: "private" }));
    await root.whenCommitted();
    expect(ref.current).toBe(handle);
    expect(findNodeHandle(handle)).toBeGreaterThan(0);
    root.unmount();
    expect(findNodeHandle(handle)).toBe(null);
  } finally {
    root.unmount();
    input.dispose();
  }
});

const text = {
  prepare() {},
  metrics: () => ({ lineHeight: 20, width: (value: string) => value.length * 8 }),
};

it("retires a focus request issued by an effect before StrictMode cleanup even if the handle rebinds", async () => {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput(),
    ref = createRef<NativeViewHandle>();
  let release!: () => void,
    setups = 0;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const root = createNativeRoot(scene, {
    input,
    strictMode: true,
    viewport: { width: 800, height: 600 },
    text: { ...text, prepare: () => ready },
  });
  function Probe() {
    const requested = useRef(false);
    useLayoutEffect(() => {
      setups++;
      if (!requested.current) {
        requested.current = true;
        ref.current!.focus();
        AccessibilityInfo.setAccessibilityFocus(findNodeHandle(ref.current)!);
        AccessibilityInfo.sendAccessibilityEvent(ref.current!, "focus");
      }
    }, []);
    return createElement(
      Pressable,
      { ref, nativeID: "replayed" },
      createElement(Text, {}, "Replayed"),
    );
  }
  try {
    root.render(createElement(StrictMode, {}, createElement(Probe)));
    expect(setups).toBeGreaterThanOrEqual(2);
    release();
    await root.whenCommitted();
    await Promise.resolve();
    expect(
      scene.operations.filter(
        (operation) => operation.operation === "set" && operation.field === "gainFocus",
      ),
    ).toEqual([]);
  } finally {
    release();
    root.unmount();
    input.dispose();
  }
});

it("ordinary native focus() submits a request and survives React effect replay without synthesizing focus", async () => {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput(),
    ref = createRef<NativeViewHandle>();
  const root = createNativeRoot(scene, {
    input,
    text,
    strictMode: true,
    viewport: { width: 800, height: 600 },
  });
  try {
    root.render(
      createElement(StrictMode, {}, createElement(Pressable, { ref, nativeID: "ordinary-focus" })),
    );
    await root.whenCommitted();
    ref.current!.focus();
    expect(input.focusedID).toBe(null);
    const node = [...scene.nodes.values()].find((node) => node.fields.id === "ordinary-focus")!;
    expect(node.fields.gainFocus).toBe(true);
    expect(findNodeHandle(ref.current)).toBeGreaterThan(0);
    AccessibilityInfo.setAccessibilityFocus(findNodeHandle(ref.current)!);
    expect(input.focusedID).toBe(null);
    scene.emit(node, "focusedChild", "ordinary-focus");
    expect(input.focusedID).toBe("ordinary-focus");
  } finally {
    root.unmount();
    input.dispose();
  }
  expect(scene.nodes.size).toBe(1);
  expect(scene.listenerCount).toBe(0);
});

it("a retired native ref cannot focus, measure or mutate a replacement with the same authored ID", async () => {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput(),
    ref = createRef<NativeViewHandle>();
  const root = createNativeRoot(scene, { input, text, viewport: { width: 800, height: 600 } });
  try {
    root.render(
      createElement(Pressable, {
        key: "old",
        ref,
        nativeID: "same",
        style: { width: 100, height: 20 },
      }),
    );
    await root.whenCommitted();
    const old = ref.current!;
    const tag = findNodeHandle(old);
    root.render(
      createElement(Pressable, {
        key: "new",
        ref,
        nativeID: "same",
        style: { width: 200, height: 40 },
      }),
    );
    await root.whenCommitted();
    expect(findNodeHandle(old)).toBe(null);
    expect(findNodeHandle(ref.current)).not.toBe(tag);
    let measurements = 0;
    old.measure(() => measurements++);
    old.measureInWindow(() => measurements++);
    expect(() => old.setNativeProps({ style: { opacity: 0 } })).toThrow("retired view");
    const count = scene.operations.length;
    old.focus();
    old.requestTVFocus();
    AccessibilityInfo.setAccessibilityFocus(tag!);
    AccessibilityInfo.sendAccessibilityEvent(old, "focus");
    await root.whenCommitted();
    expect(scene.operations.length).toBe(count);
    expect(measurements).toBe(0);
    ref.current!.measure((_x, _y, width) => expect(width).toBe(200));
    ref.current!.focus();
    expect(
      [...scene.nodes.values()].find((node) => node.fields.id === "same")?.fields.gainFocus,
    ).toBe(true);
  } finally {
    root.unmount();
    input.dispose();
  }
});

it("pending focus/measurement from a removed ref is fenced through delayed native/font commit", async () => {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput(),
    ref = createRef<NativeViewHandle>();
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const root = createNativeRoot(scene, {
    input,
    viewport: { width: 800, height: 600 },
    text: { ...text, prepare: () => ready },
  });
  let measurements = 0;
  try {
    root.render(
      createElement(
        Pressable,
        { key: "old", ref, nativeID: "same" },
        createElement(Text, {}, "Old"),
      ),
    );
    const old = ref.current!;
    old.focus();
    old.measure(() => measurements++);
    AccessibilityInfo.setAccessibilityFocus(findNodeHandle(old)!);
    AccessibilityInfo.sendAccessibilityEvent(old, "focus");
    root.render(
      createElement(
        Pressable,
        { key: "new", ref, nativeID: "same" },
        createElement(Text, {}, "New"),
      ),
    );
    release();
    await root.whenCommitted();
    await Promise.resolve();
    expect(measurements).toBe(0);
    expect(
      scene.operations.filter(
        (operation) => operation.operation === "set" && operation.field === "gainFocus",
      ),
    ).toEqual([]);
    expect(input.focusedID).toBe(null);
  } finally {
    release();
    root.unmount();
    input.dispose();
  }
});
