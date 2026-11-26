import { createElement, createRef, useLayoutEffect, type ElementRef } from "react";
import { describe, expect, it } from "vitest";
import { createNativeRoot } from "./createNativeRoot";
import { View, Text, Pressable } from "./primitives";
import { NativeInput } from "./NativeInput";
import type { NativeViewHandle } from "./nativeViewHandle";
import { findNodeHandle } from "./nativeViewHandle";
import type { TextMetricProvider } from "../layout/textLayout";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import { rokuColor, StyleSheet } from "./styleSheet";
import { useNativeHost, type NativeHostContextValue } from "./nativeHostContext";
import { NativeSystemState } from "./NativeSystemState";

const text: TextMetricProvider = {
  prepare: () => undefined,
  metrics: () => ({
    lineHeight: 20,
    width: (value) => Array.from(value).length * 7,
  }),
};

describe("native primitive conformance (host evidence)", () => {
  it("reconciles imperative accessibility exposure and announces only observed exposed focus", async () => {
    const scene = new RecordingSceneGraph(),
      input = new NativeInput(),
      announcements: string[] = [];
    const system = new NativeSystemState({ screenReader: true }, (message) =>
      announcements.push(message),
    );
    let host!: NativeHostContextValue;
    function Probe() {
      host = useNativeHost();
      return null;
    }
    const root = createNativeRoot(scene, {
      viewport: { width: 800, height: 600 },
      text,
      input,
      system,
    });
    const ref = createRef<NativeViewHandle>();
    const render = (importance: "auto" | "yes", pointerEvents: "auto" | "box-only") =>
      root.render(
        createElement(
          View,
          {
            ref,
            nativeID: "overlay",
            importantForAccessibility: importance,
            pointerEvents,
          },
          createElement(Probe),
          createElement(Pressable, {
            nativeID: "play",
            accessibilityLabel: "Pause",
          }),
        ),
      );
    render("auto", "auto");
    await root.whenCommitted();
    ref.current!.setNativeProps({
      importantForAccessibility: "no-hide-descendants",
      style: { pointerEvents: "none" },
    });
    await root.whenCommitted();
    expect(host.placement("play")?.accessibilityHidden).toBe(true);
    expect(host.placement("overlay")?.pointerEvents).toBe("none");
    const button = [...scene.nodes.values()].find((node) => node.fields.id === "play")!;
    scene.emit(button, "focusedChild", "play");
    expect(announcements).toEqual([]);
    render("yes", "box-only");
    await root.whenCommitted();
    expect(host.placement("play")?.accessibilityHidden).toBe(false);
    expect(host.placement("overlay")?.pointerEvents).toBe("box-only");
    scene.emit(button, "focusedChild", null);
    ref.current!.requestTVFocus();
    expect(announcements).toEqual([]);
    scene.emit(button, "focusedChild", "play");
    expect(announcements).toEqual(["Pause"]);
    root.unmount();
    input.dispose();
  });
  it("applies immediate overlay opacity and yields to a changed declarative value", async () => {
    const scene = new RecordingSceneGraph(),
      ref = createRef<NativeViewHandle>();
    const root = createNativeRoot(scene, {
      viewport: { width: 800, height: 600 },
      text,
    });
    const render = (opacity: number) =>
      root.render(
        createElement(View, {
          ref,
          nativeID: "overlay",
          style: { width: 100, height: 100, opacity },
        }),
      );
    render(0);
    await root.whenCommitted();
    const overlay = [...scene.nodes.values()].find((node) => node.fields.id === "overlay")!;
    ref.current!.setNativeProps({
      importantForAccessibility: "auto",
      style: { opacity: 1, pointerEvents: "auto" },
    });
    expect(overlay.fields.opacity).toBe(1);
    await root.whenCommitted();
    render(0);
    await root.whenCommitted();
    expect(overlay.fields.opacity).toBe(1);
    render(0.5);
    await root.whenCommitted();
    expect(overlay.fields.opacity).toBe(0.5);
    expect(() => ref.current!.setNativeProps({ style: { opacity: NaN } })).toThrow(
      "renderer binding",
    );
    root.unmount();
    expect(scene.nodes.size).toBe(1);
  });
  it("measures scaled TV viewports in window coordinates while retaining logical relative layout", async () => {
    const scene = new RecordingSceneGraph(),
      parent = createRef<NativeViewHandle>(),
      child = createRef<NativeViewHandle>();
    const root = createNativeRoot(scene, {
      viewport: { width: 800, height: 600 },
      text,
    });
    root.render(
      createElement(
        View,
        {
          ref: parent,
          style: { width: 100, height: 100, transform: [{ scale: 2 }] },
        },
        createElement(View, {
          ref: child,
          style: {
            position: "absolute",
            left: 10,
            top: 20,
            width: 30,
            height: 10,
          },
        }),
      ),
    );
    await root.whenCommitted();
    const window: number[][] = [],
      local: number[][] = [],
      measured: number[][] = [];
    child.current!.measureInWindow((...value) => window.push(value));
    child.current!.measureLayout(parent.current!, (...value) => local.push(value));
    child.current!.measure((...value) => measured.push(value));
    expect(window).toEqual([[-30, -10, 60, 20]]);
    expect(local).toEqual([[10, 20, 30, 10]]);
    expect(measured).toEqual([[10, 20, 60, 20, -30, -10]]);
    root.unmount();
    expect(scene.nodes.size).toBe(1);
  });
  it("executes directional tags, waits for observed focus before activation, and retires held input", async () => {
    const port = new RecordingSceneGraph(),
      input = new NativeInput(),
      first = createRef<NativeViewHandle>(),
      second = createRef<NativeViewHandle>(),
      activated: string[] = [];
    const root = createNativeRoot(port, {
      viewport: { width: 800, height: 600 },
      text,
      input,
    });
    root.render(
      createElement(
        View,
        { style: { flexDirection: "row" } },
        createElement(Pressable, {
          nativeID: "first",
          ref: first,
          style: { width: 100, height: 50 },
          onPress: () => activated.push("first"),
        }),
        createElement(Pressable, {
          nativeID: "second",
          ref: second,
          style: { width: 100, height: 50 },
          onPress: () => activated.push("second"),
        }),
      ),
    );
    await root.whenCommitted();
    const firstNode = [...port.nodes.values()].find((node) => node.fields.id === "first")!,
      secondNode = [...port.nodes.values()].find((node) => node.fields.id === "second")!;
    const firstTag = findNodeHandle(first.current)!,
      secondTag = findNodeHandle(second.current)!;
    first.current!.setNativeProps({
      nextFocusRight: secondTag,
      nextFocusLeft: firstTag,
    });
    second.current!.setNativeProps({ nextFocusLeft: firstTag });
    port.emit(firstNode, "focusedChild", "first");
    expect(input.dispatch({ key: "left", phase: "down" })).toBe(true);
    expect(input.focusedID).toBe("first");
    expect(input.dispatch({ key: "right", phase: "down" })).toBe(true);
    expect(secondNode.fields.gainFocus).toBe(true);
    expect(input.focusedID).toBe("first");
    input.dispatch({ key: "select", phase: "down" });
    expect(activated).toEqual([]);
    port.emit(secondNode, "focusedChild", "second");
    expect(activated).toEqual([]);
    input.dispatch({ key: "select", phase: "up" });
    expect(activated).toEqual(["second"]);
    input.dispatch({ key: "select", phase: "down" });
    input.dispatch({ key: "select", phase: "up" });
    expect(activated).toEqual(["second", "second"]);
    input.dispatch({ key: "select", phase: "down" });
    input.dispatch({ key: "left", phase: "down" });
    port.emit(firstNode, "focusedChild", "first");
    input.dispatch({ key: "select", phase: "up" });
    expect(activated).toEqual(["second", "second"]);
    root.unmount();
    input.dispose();
    expect(port.nodes.size).toBe(1);
    expect(port.listenerCount).toBe(0);
  });
  it("releases resources and retires the root even when a failed font preparation is surfaced during unmount", async () => {
    const port = new RecordingSceneGraph();
    let disposed = 0;
    const root = createNativeRoot(port, {
      viewport: { width: 800, height: 600 },
      text: {
        prepare: () => Promise.reject(new Error("font failed")),
        metrics: text.metrics,
        dispose: () => {
          disposed++;
        },
      },
    });
    root.render(createElement(Text, {}, "Unmeasurable"));
    await expect(root.whenCommitted()).rejects.toThrow("font failed");
    expect(() => root.unmount()).toThrow("font failed");
    expect(root.mounted).toBe(false);
    expect(disposed).toBe(1);
    root.unmount();
    expect(disposed).toBe(1);
  });
  it("executes nested text and publishes committed layout/ref measurements", async () => {
    const port = new RecordingSceneGraph();
    const root = createNativeRoot(port, {
      viewport: { width: 800, height: 600 },
      text,
    });
    const frame = createRef<NativeViewHandle>();
    const label = createRef<ElementRef<typeof Text>>();
    const layouts: unknown[] = [];
    root.render(
      createElement(
        View,
        {
          ref: frame,
          style: { width: 300, padding: 20 },
          onLayout: (event) => layouts.push(event),
        },
        createElement(
          Text,
          {
            ref: label,
            style: { fontSize: 16, lineHeight: 21 },
            numberOfLines: 1,
          },
          "Native package consumer",
        ),
      ),
    );
    await root.whenCommitted();
    expect(port.snapshot()).toMatchObject({
      children: [
        {
          type: "group",
          children: [
            {
              type: "label",
              fields: {
                text: "Native package consumer",
                width: 260,
                height: 21,
                translation: [20, 20],
              },
            },
          ],
        },
      ],
    });
    const measurements: number[][] = [];
    label.current!.measure((...values) => measurements.push(values));
    expect(measurements).toEqual([[20, 20, 260, 21, 20, 20]]);
    expect(layouts).toHaveLength(1);
    root.unmount();
    expect(port.nodes.size).toBe(1);
  });

  it("waits for real font readiness without publishing fabricated zero measurements", async () => {
    let release!: () => void;
    let ready = false;
    const preparation = new Promise<void>((resolve) => {
      release = () => {
        ready = true;
        resolve();
      };
    });
    const provider: TextMetricProvider = {
      prepare: () => (ready ? undefined : preparation),
      metrics: text.metrics,
    };
    const port = new RecordingSceneGraph(),
      root = createNativeRoot(port, {
        viewport: { width: 800, height: 600 },
        text: provider,
      });
    const ref = createRef<NativeViewHandle>(),
      measurements: number[][] = [];
    root.render(
      createElement(
        View,
        { style: { padding: 10 } },
        createElement(Text, { ref, style: { width: 100 } }, "font"),
      ),
    );
    ref.current!.measure((...values) => measurements.push(values));
    const tag = findNodeHandle(ref.current);
    expect(tag).toBeTypeOf("number");
    ref.current!.requestTVFocus();
    expect(measurements).toEqual([]);
    expect(port.nodes.size).toBe(1);
    release();
    await root.whenCommitted();
    await Promise.resolve();
    expect(measurements).toEqual([[10, 10, 100, 20, 10, 10]]);
    expect(findNodeHandle(ref.current)).toBe(tag);
    expect(port.root.children[0].children[0].fields.gainFocus).toBe(true);
    const retiredHandle = ref.current;
    root.unmount();
    expect(findNodeHandle(retiredHandle)).toBeNull();
  });

  it("requests focus without manufacturing a device focus acknowledgement", () => {
    const port = new RecordingSceneGraph(),
      root = createNativeRoot(port, {
        viewport: { width: 800, height: 600 },
        text,
      });
    const ref = createRef<NativeViewHandle>();
    root.render(createElement(View, { ref, style: { width: 100, height: 50 } }));
    ref.current!.requestTVFocus();
    expect(port.root.children[0].fields.gainFocus).toBe(true);
    expect(port.root.children[0].fields.focused).toBeUndefined();
    root.unmount();
  });

  it("retires deferred native focus on background and waits for a fresh foreground request", async () => {
    let release!: () => void;
    let ready = false;
    const preparation = new Promise<void>((resolve) => {
      release = () => {
        ready = true;
        resolve();
      };
    });
    const port = new RecordingSceneGraph(),
      input = new NativeInput(),
      system = new NativeSystemState({ appState: "active" });
    const root = createNativeRoot(port, {
      input,
      system,
      viewport: { width: 800, height: 600 },
      text: { ...text, prepare: () => (ready ? undefined : preparation) },
    });
    const ref = createRef<NativeViewHandle>();
    root.render(
      createElement(
        Pressable,
        { ref, style: { width: 100, height: 50 } },
        createElement(Text, null, "pending"),
      ),
    );
    ref.current!.requestTVFocus();
    system.publish({ appState: "background" });
    release();
    await root.whenCommitted();
    expect(port.operations.some((op) => op.field === "gainFocus")).toBe(false);
    ref.current!.requestTVFocus();
    expect(port.operations.some((op) => op.field === "gainFocus")).toBe(false);
    system.publish({ appState: "active" });
    ref.current!.requestTVFocus();
    expect(port.operations.filter((op) => op.field === "gainFocus")).toHaveLength(1);
    expect(input.focusedID).toBeNull();
    root.unmount();
    input.dispose();
  });

  it("orders a retained target's focus command after its asynchronous eligibility commit", async () => {
    let blocked = false;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = () => {
        blocked = false;
        resolve();
      };
    });
    const port = new RecordingSceneGraph(),
      input = new NativeInput();
    const root = createNativeRoot(port, {
      input,
      viewport: { width: 800, height: 600 },
      text: { ...text, prepare: () => (blocked ? ready : undefined) },
    });
    const ref = createRef<NativeViewHandle>();
    function Retained({ enabled }: { enabled: boolean }) {
      useLayoutEffect(() => {
        if (enabled) ref.current!.requestTVFocus();
      }, [enabled]);
      return createElement(
        Pressable,
        {
          ref,
          nativeID: "retained",
          focusable: enabled,
          style: { width: 100, height: 50 },
        },
        createElement(Text, null, "ready"),
      );
    }
    root.render(createElement(Retained, { enabled: false }));
    const target = [...port.nodes.values()].find((node) => node.fields.id === "retained")!;
    expect(target.fields.focusable).toBe(false);
    port.operations.length = 0;
    blocked = true;
    root.render(createElement(Retained, { enabled: true }));
    expect(port.operations.some((op) => op.field === "gainFocus")).toBe(false);
    release();
    await root.whenCommitted();
    await Promise.resolve();
    const enabled = port.operations.findIndex(
      (op) => op.node === target.id && op.field === "focusable" && op.value === true,
    );
    const focused = port.operations.findIndex(
      (op) => op.node === target.id && op.field === "gainFocus" && op.value === true,
    );
    expect(enabled).toBeGreaterThanOrEqual(0);
    expect(focused).toBeGreaterThan(enabled);
    expect(input.focusedID).toBeNull();
    root.unmount();
    input.dispose();
  });

  it("preserves style-array precedence and converts RGBA colors without discarding alpha", () => {
    expect(StyleSheet.flatten([{ width: 10, color: "red" }, false, [{ width: 20 }]])).toEqual({
      width: 20,
      color: "red",
    });
    expect(rokuColor("rgba(255, 0, 128, 0.5)")).toBe("0xFF008080");
    expect(rokuColor("#abcd")).toBe("0xAABBCCDD");
    expect(() => rokuColor("var(--unresolved-color)")).toThrow(/C05_COLOR/);
  });

  it("styles Pressable from observed native focus and preserves one activation across repeats", async () => {
    const port = new RecordingSceneGraph(),
      input = new NativeInput();
    const root = createNativeRoot(port, {
      viewport: { width: 800, height: 600 },
      text,
      input,
    });
    const ref = createRef<NativeViewHandle>(),
      events: string[] = [];
    root.render(
      createElement(
        Pressable,
        {
          ref,
          nativeID: "button",
          hasTVPreferredFocus: true,
          style: (state) => ({
            width: 140,
            height: 60,
            opacity: state.focused ? 1 : 0.5,
          }),
          onFocus: () => events.push("focus"),
          onPressIn: () => events.push("in"),
          onPressOut: () => events.push("out"),
          onPress: () => events.push("press"),
        },
        createElement(Text, {}, "Select"),
      ),
    );
    await root.whenCommitted();
    await Promise.resolve();
    const button = port.root.children[0];
    expect(button.fields.gainFocus).toBe(true);
    expect(button.fields.opacity).toBe(0.5);
    expect(events).toEqual([]);
    input.dispatch({ key: "select", phase: "down" });
    input.dispatch({ key: "select", phase: "up" });
    expect(events).toEqual([]);
    port.emit(button, "focusedChild", "button");
    expect(input.focusedID).toBe("button");
    expect(button.fields.opacity).toBe(1);
    input.dispatch({ key: "select", phase: "down" });
    input.dispatch({ key: "select", phase: "repeat" });
    input.dispatch({ key: "select", phase: "up" });
    expect(events).toEqual(["focus", "in", "out", "press"]);
    root.unmount();
    expect(input.targetCount).toBe(0);
    expect(port.listenerCount).toBe(0);
    expect(port.nodes.size).toBe(1);
    input.dispose();
  });

  it("cancels preferred focus when the target unmounts before fonts become measurable", async () => {
    let ready!: () => void;
    const wait = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const port = new RecordingSceneGraph(),
      input = new NativeInput();
    const root = createNativeRoot(port, {
      viewport: { width: 800, height: 600 },
      input,
      text: { prepare: () => wait, metrics: text.metrics },
    });
    root.render(
      createElement(
        Pressable,
        { nativeID: "retired", hasTVPreferredFocus: true },
        createElement(Text, {}, "Waiting"),
      ),
    );
    root.unmount();
    ready();
    await Promise.resolve();
    await Promise.resolve();
    expect(port.nodes.size).toBe(1);
    expect(input.targetCount).toBe(0);
    input.dispose();
  });
});

it("preserves View ref, native identity and measurement across collapse hints", async () => {
  const scene = new RecordingSceneGraph(),
    ref = createRef<NativeViewHandle>();
  const root = createNativeRoot(scene, { viewport: { width: 800, height: 600 }, text });
  try {
    root.render(
      createElement(View, {
        ref,
        nativeID: "measured",
        collapsable: false,
        style: { width: 120, height: 40 },
      }),
    );
    await root.whenCommitted();
    const node = [...scene.nodes.values()].find((node) => node.fields.id === "measured");
    expect(node?.type).toBe("group");
    const handle = ref.current;
    let rect: number[] = [];
    ref.current!.measureInWindow((...values) => {
      rect = values;
    });
    expect(rect).toEqual([0, 0, 120, 40]);
    root.render(
      createElement(View, {
        ref,
        nativeID: "measured",
        collapsable: true,
        style: { width: 120, height: 40 },
      }),
    );
    await root.whenCommitted();
    expect(ref.current).toBe(handle);
    expect([...scene.nodes.values()].find((node) => node.fields.id === "measured")).toBe(node);
  } finally {
    root.unmount();
  }
  expect(scene.nodes.size).toBe(1);
});
