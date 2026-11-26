import { createElement, createRef } from "react";
import { describe, expect, it } from "vitest";
import { createNativeRoot } from "./createNativeRoot";
import { NativeInput } from "./NativeInput";
import { View, Pressable } from "./primitives";
import { ScrollView } from "./scrollView";
import { Modal } from "./modal";
import { findNodeHandle, type NativeViewHandle } from "./nativeViewHandle";
import { dispatchNativeFocus, type NativeFocusEvent } from "./focusEvents";
import type { NativePlacement } from "./nativeHostContext";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";

const text = {
  prepare() {},
  metrics: () => ({ lineHeight: 20, width: (value: string) => value.length * 7 }),
};
const settle = async (root: ReturnType<typeof createNativeRoot>) => {
  for (let i = 0; i < 5; i++) {
    await root.whenCommitted();
    root.flush();
  }
};

describe("committed native focus propagation", () => {
  it("keeps authored empty native IDs in the observed focus path", async () => {
    const scene = new RecordingSceneGraph(),
      input = new NativeInput();
    const root = createNativeRoot(scene, { input, text, viewport: { width: 800, height: 600 } });
    const calls: string[] = [];
    try {
      root.render(
        createElement(
          View,
          { nativeID: "page", onFocus: () => calls.push("page") },
          createElement(
            View,
            {
              nativeID: "",
              onFocus: (event) => calls.push("empty:" + event.currentTarget.nativeID),
            },
            createElement(Pressable, { nativeID: "entry" }),
          ),
        ),
      );
      await settle(root);
      input.observeFocus("entry", true);
      await settle(root);
      expect(calls).toEqual(["empty:", "page"]);
    } finally {
      root.unmount();
      input.dispose();
    }
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
  });

  it("captures and bubbles observed focus through scroll ancestors with measurable original target identity", async () => {
    const scene = new RecordingSceneGraph(),
      input = new NativeInput();
    const root = createNativeRoot(scene, { input, text, viewport: { width: 800, height: 600 } });
    const target = createRef<NativeViewHandle>(),
      calls: string[] = [],
      measured: number[] = [];
    const record = (name: string) => (event: NativeFocusEvent) => {
      calls.push(name + ":" + event.currentTarget.nativeID);
      expect(event.target).toBe(target.current);
      expect(event.nativeEvent.target).toBe(findNodeHandle(target.current));
      event.target.measureInWindow((_x: number, y: number) => measured.push(y));
    };
    try {
      root.render(
        createElement(
          View,
          {
            nativeID: "page",
            onFocusCapture: record("capture"),
            onFocus: record("bubble"),
          },
          createElement(
            ScrollView,
            {
              nativeID: "scroll",
              style: { width: 200, height: 100 },
              onFocusCapture: record("capture"),
              onFocus: record("bubble"),
            },
            createElement(
              View,
              { style: { height: 400 } },
              createElement(Pressable, {
                ref: target,
                nativeID: "entry",
                style: { marginTop: 220, height: 40 },
                onFocusCapture: record("capture"),
                onFocus: record("bubble"),
              }),
            ),
          ),
        ),
      );
      await settle(root);
      target.current!.requestTVFocus();
      await settle(root);
      expect(calls).toEqual([]);
      input.observeFocus("entry", true);
      await settle(root);
      expect(calls).toEqual([
        "capture:page",
        "capture:scroll",
        "capture:entry",
        "bubble:entry",
        "bubble:scroll",
        "bubble:page",
      ]);
      expect(measured).toEqual([220, 220, 220, 220, 220, 220]);
      input.observeFocus("entry", true);
      expect(calls).toHaveLength(6);
    } finally {
      root.unmount();
      input.dispose();
    }
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
  });

  it("honors propagation cancellation and delivers blur without inventing an acknowledgement", async () => {
    const scene = new RecordingSceneGraph(),
      input = new NativeInput();
    const root = createNativeRoot(scene, { input, text, viewport: { width: 800, height: 600 } });
    const calls: string[] = [];
    try {
      root.render(
        createElement(
          View,
          {
            onFocusCapture: () => calls.push("capture"),
            onFocus: () => calls.push("outer-focus"),
            onBlur: () => calls.push("outer-blur"),
          },
          createElement(Pressable, {
            nativeID: "first",
            onFocus: (event: NativeFocusEvent) => {
              calls.push("first-focus");
              event.stopPropagation();
            },
            onBlur: () => calls.push("first-blur"),
          }),
          createElement(Pressable, {
            nativeID: "second",
            onFocus: () => calls.push("second-focus"),
          }),
        ),
      );
      await settle(root);
      input.observeFocus("first", true);
      await settle(root);
      input.observeFocus("second", true);
      await settle(root);
      expect(calls).toEqual([
        "capture",
        "first-focus",
        "first-blur",
        "outer-blur",
        "capture",
        "second-focus",
        "outer-focus",
      ]);
      root.render(null);
      await settle(root);
      const count = calls.length;
      input.observeFocus("second", true);
      expect(calls).toHaveLength(count);
      expect(input.targetCount).toBe(0);
    } finally {
      root.unmount();
      input.dispose();
    }
    expect(scene.listenerCount).toBe(0);
  });

  it("keeps portalled modal focus outside the background scroll hierarchy", async () => {
    const scene = new RecordingSceneGraph(),
      input = new NativeInput();
    const root = createNativeRoot(scene, { input, text, viewport: { width: 800, height: 600 } });
    const calls: string[] = [];
    try {
      root.render(
        createElement(
          ScrollView,
          { onFocus: () => calls.push("background") },
          createElement(
            Modal,
            { visible: true, animationType: "none" },
            createElement(
              View,
              { onFocus: () => calls.push("modal") },
              createElement(Pressable, { nativeID: "dialog-action" }),
            ),
          ),
        ),
      );
      await settle(root);
      input.observeFocus("dialog-action", true);
      await settle(root);
      expect(calls).toEqual(["modal"]);
    } finally {
      root.unmount();
      input.dispose();
    }
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
  });
});

it("reads committed focus bindings for the whole path before capture invokes the app", () => {
  const calls: string[] = [];
  let committed = { onFocus: () => calls.push("old") };
  const active = () => true;
  const placement = (
    id: string,
    focusEvents: NativePlacement["focusEvents"],
    parentID?: string,
  ): NativePlacement => {
    const rect = { x: 0, y: 0, width: 80, height: 40 };
    return {
      parentID,
      view: { nativeID: id } as NativeViewHandle,
      local: rect,
      global: rect,
      handle: { nativeRef: null },
      focusEvents,
    };
  };
  const placements = new Map([
    [
      "container",
      placement("container", {
        onFocusCapture() {
          calls.push("capture");
          committed = { onFocus: () => calls.push("new") };
        },
      }),
    ],
    ["target", placement("target", () => committed, "container")],
  ]);
  dispatchNativeFocus(placements, "target", true, active);
  dispatchNativeFocus(placements, "target", true, active);
  expect(calls).toEqual(["capture", "old", "capture", "new"]);
});
