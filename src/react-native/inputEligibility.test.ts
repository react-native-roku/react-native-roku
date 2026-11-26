import { createElement, createRef, useLayoutEffect } from "react";
import { expect, it, vi } from "vitest";
import { createNativeRoot } from "./createNativeRoot";
import { NativeInput } from "./NativeInput";
import { Pressable, Text, View } from "./primitives";
import { findNodeHandle, type NativeViewHandle } from "./nativeViewHandle";
import { AccessibilityInfo } from "./environment";
import { NativeSystemState } from "./NativeSystemState";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";

const text = {
  prepare() {},
  metrics: () => ({ lineHeight: 20, width: (value: string) => value.length * 8 }),
};
const settle = async (root: ReturnType<typeof createNativeRoot>) => {
  for (let i = 0; i < 4; i++) {
    await root.whenCommitted();
    root.flush();
  }
};

it.each(["View", "Text"])("honors explicit focus admission on a plain %s ref", async (kind) => {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput(),
    ref = createRef<NativeViewHandle>();
  const root = createNativeRoot(scene, { input, text, viewport: { width: 800, height: 600 } });
  const component = kind === "View" ? View : Text;
  const child = kind === "Text" ? "Plain" : undefined;
  try {
    root.render(createElement(component, { ref, nativeID: "plain", focusable: false }, child));
    await settle(root);
    ref.current!.focus();
    AccessibilityInfo.sendAccessibilityEvent(ref.current!, "focus");
    await settle(root);
    expect(
      scene.operations.filter((op) => op.operation === "set" && op.field === "gainFocus"),
    ).toEqual([]);
    expect(
      [...scene.nodes.values()].find((node) => node.fields.id === "plain")?.fields.focusable,
    ).toBe(false);
    root.render(createElement(component, { ref, nativeID: "plain", focusable: true }, child));
    await settle(root);
    AccessibilityInfo.sendAccessibilityEvent(ref.current!, "focus");
    expect(
      [...scene.nodes.values()].find((node) => node.fields.id === "plain")?.fields.gainFocus,
    ).toBe(true);
    expect(input.focusedID).toBe(null);
  } finally {
    root.unmount();
    input.dispose();
  }
});

it.each(["modal", "disabled", "focusable", "hidden"])(
  "does not cancel a foreground press or submit native focus for a committed %s target",
  async (blocked) => {
    const scene = new RecordingSceneGraph(),
      input = new NativeInput(),
      ref = createRef<NativeViewHandle>(),
      press = vi.fn();
    const root = createNativeRoot(scene, { input, text, viewport: { width: 800, height: 600 } });
    try {
      root.render(
        createElement(
          View,
          {},
          createElement(Pressable, {
            ref,
            nativeID: "ineligible",
            disabled: blocked === "disabled",
            focusable: blocked === "focusable" ? false : undefined,
            style: { display: blocked === "hidden" ? "none" : "flex" },
          }),
          createElement(
            View,
            { "aria-modal": blocked === "modal" },
            createElement(Pressable, { nativeID: "foreground", onPress: press }),
          ),
        ),
      );
      await settle(root);
      expect(
        [...scene.nodes.values()].find((node) => node.fields.id === "ineligible")?.fields.focusable,
      ).toBe(false);
      input.observeFocus("foreground", true);
      input.dispatch({ key: "select", phase: "down" });
      ref.current!.focus();
      await settle(root);
      input.dispatch({ key: "select", phase: "up" });
      expect(input.focusedID).toBe("foreground");
      expect(press).toHaveBeenCalledTimes(1);
      expect(
        scene.operations.filter((op) => op.operation === "set" && op.field === "gainFocus"),
      ).toEqual([]);
    } finally {
      root.unmount();
      input.dispose();
    }
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
  },
);

it("preserves an eligible deferred focus request when a later disabled ref asks for focus", async () => {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput();
  const valid = createRef<NativeViewHandle>(),
    disabled = createRef<NativeViewHandle>();
  let blocked = false,
    release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = () => {
      blocked = false;
      resolve();
    };
  });
  const root = createNativeRoot(scene, {
    input,
    text: { ...text, prepare: () => (blocked ? ready : undefined) },
    viewport: { width: 800, height: 600 },
  });
  const render = (label: string) =>
    root.render(
      createElement(
        View,
        {},
        createElement(Pressable, { ref: valid, nativeID: "valid" }, createElement(Text, {}, label)),
        createElement(Pressable, { ref: disabled, nativeID: "disabled", disabled: true }),
      ),
    );
  try {
    render("Before");
    await settle(root);
    blocked = true;
    render("Pending");
    valid.current!.focus();
    disabled.current!.focus();
    expect(scene.operations.filter((op) => op.field === "gainFocus")).toEqual([]);
    release();
    await settle(root);
    const node = [...scene.nodes.values()].find((node) => node.fields.id === "valid")!;
    expect(scene.operations.filter((op) => op.field === "gainFocus").map((op) => op.node)).toEqual([
      node.id,
    ]);
    expect(input.focusedID).toBe(null);
  } finally {
    release();
    root.unmount();
    input.dispose();
  }
  expect(scene.nodes.size).toBe(1);
  expect(scene.listenerCount).toBe(0);
});

it("lets a newer focus request from press cancellation supersede the original native command", async () => {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput();
  const second = createRef<NativeViewHandle>(),
    third = createRef<NativeViewHandle>();
  const root = createNativeRoot(scene, { input, text, viewport: { width: 800, height: 600 } });
  try {
    root.render(
      createElement(
        View,
        {},
        createElement(Pressable, { nativeID: "first", onPressOut: () => third.current!.focus() }),
        createElement(Pressable, { ref: second, nativeID: "second" }),
        createElement(Pressable, { ref: third, nativeID: "third" }),
      ),
    );
    await settle(root);
    input.observeFocus("first", true);
    input.dispatch({ key: "select", phase: "down" });
    second.current!.focus();
    const node = [...scene.nodes.values()].find((node) => node.fields.id === "third")!;
    expect(scene.operations.filter((op) => op.field === "gainFocus").map((op) => op.node)).toEqual([
      node.id,
    ]);
    expect(input.focusedID).toBe("first");
  } finally {
    root.unmount();
    input.dispose();
  }
  expect(scene.nodes.size).toBe(1);
  expect(scene.listenerCount).toBe(0);
});

it("retires a pending input fence when its committed target becomes disabled before acknowledgement", async () => {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput(),
    ref = createRef<NativeViewHandle>(),
    press = vi.fn();
  const root = createNativeRoot(scene, { input, text, viewport: { width: 800, height: 600 } });
  const render = (disabled: boolean) =>
    root.render(
      createElement(
        View,
        {},
        createElement(Pressable, { nativeID: "foreground", onPress: press }),
        createElement(Pressable, { ref, nativeID: "requested", disabled }),
      ),
    );
  try {
    render(false);
    await settle(root);
    input.observeFocus("foreground", true);
    ref.current!.focus();
    render(true);
    await settle(root);
    input.dispatch({ key: "select", phase: "down" });
    input.dispatch({ key: "select", phase: "up" });
    expect(input.focusedID).toBe("foreground");
    expect(press).toHaveBeenCalledTimes(1);
  } finally {
    root.unmount();
    input.dispose();
  }
  expect(scene.nodes.size).toBe(1);
  expect(scene.listenerCount).toBe(0);
});

it.each(["none", "box-none", "box-only"])(
  "keeps non-touch focus independent of pointerEvents=%s and accessibility exclusion",
  async (pointerEvents) => {
    const scene = new RecordingSceneGraph(),
      input = new NativeInput(),
      ref = createRef<NativeViewHandle>(),
      press = vi.fn(),
      speech = vi.fn();
    const root = createNativeRoot(scene, {
      input,
      system: new NativeSystemState({ screenReader: true }, speech),
      text: { ...text, prepare: async () => {} },
      viewport: { width: 800, height: 600 },
    });
    function Probe() {
      useLayoutEffect(() => ref.current!.focus(), []);
      return createElement(
        View,
        { pointerEvents, importantForAccessibility: "no-hide-descendants", style: { opacity: 0 } },
        createElement(Pressable, {
          ref,
          nativeID: "retained",
          onPress: press,
          accessibilityLabel: "Play",
        }),
        createElement(Text, {}, "Pending text preparation"),
      );
    }
    try {
      root.render(createElement(Probe));
      await settle(root);
      const node = [...scene.nodes.values()].find((node) => node.fields.id === "retained")!;
      expect(node.fields.focusable).toBe(true);
      expect(node.fields.gainFocus).toBe(true);
      expect(input.focusedID).toBe(null);
      scene.emit(node, "focusedChild", "retained");
      input.dispatch({ key: "select", phase: "down" });
      input.dispatch({ key: "select", phase: "up" });
      expect(press).toHaveBeenCalledTimes(1);
      const requests = () =>
        scene.operations.filter((op) => op.operation === "set" && op.field === "gainFocus");
      expect(requests()).toHaveLength(1);
      AccessibilityInfo.setAccessibilityFocus(findNodeHandle(ref.current)!);
      await settle(root);
      expect(requests()).toHaveLength(1);
      expect(speech).not.toHaveBeenCalled();
    } finally {
      root.unmount();
      input.dispose();
    }
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
  },
);

it.each(["ref", "accessibility-tag"])(
  "defers retained background %s layout-effect focus until the dismissing modal commit",
  async (request) => {
    const scene = new RecordingSceneGraph(),
      input = new NativeInput(),
      ref = createRef<NativeViewHandle>();
    const root = createNativeRoot(scene, {
      input,
      text: { ...text, prepare: async () => {} },
      viewport: { width: 800, height: 600 },
    });
    function Probe({ open }: { open: boolean }) {
      useLayoutEffect(() => {
        if (!open) {
          if (request === "ref") ref.current!.focus();
          else AccessibilityInfo.setAccessibilityFocus(findNodeHandle(ref.current)!);
        }
      }, [open]);
      return createElement(
        View,
        {},
        createElement(Pressable, { ref, nativeID: "background" }),
        createElement(Text, {}, "Asynchronous font commit"),
        open
          ? createElement(
              View,
              { "aria-modal": true },
              createElement(Pressable, { nativeID: "dialog" }),
            )
          : null,
      );
    }
    try {
      root.render(createElement(Probe, { open: true }));
      await settle(root);
      expect(input.isTargetEnabled("background")).toBe(false);
      input.observeFocus("dialog", true);
      root.render(createElement(Probe, { open: false }));
      await settle(root);
      expect(input.isTargetEnabled("background")).toBe(true);
      expect(
        scene.operations.filter((op) => op.operation === "set" && op.field === "gainFocus"),
      ).toHaveLength(1);
      expect(
        [...scene.nodes.values()].find((node) => node.fields.id === "background")?.fields.gainFocus,
      ).toBe(true);
      expect(input.focusedID).toBe(null);
    } finally {
      root.unmount();
      input.dispose();
    }
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
  },
);

it.each(["self", "ancestor"] as const)(
  "rejects retained input and focus through display:none on %s, then admits a fresh press after reveal",
  async (hiddenOwner) => {
    const scene = new RecordingSceneGraph(),
      input = new NativeInput(),
      ref = createRef<NativeViewHandle>();
    const root = createNativeRoot(scene, { input, text, viewport: { width: 800, height: 600 } });
    const press = vi.fn(),
      out = vi.fn();
    const render = (hidden: boolean) =>
      root.render(
        createElement(
          View,
          { style: { display: hidden && hiddenOwner === "ancestor" ? "none" : "flex" } },
          createElement(Pressable, {
            ref,
            nativeID: "retained",
            onPress: press,
            onPressOut: out,
            style: {
              display: hidden && hiddenOwner === "self" ? "none" : "flex",
              width: 100,
              height: 40,
            },
          }),
        ),
      );
    try {
      render(false);
      await settle(root);
      input.observeFocus("retained", true);
      input.dispatch({ key: "select", phase: "down" });
      render(true);
      await settle(root);
      expect(input.isTargetEnabled("retained")).toBe(false);
      expect(out).toHaveBeenCalledTimes(1);
      ref.current!.focus();
      await settle(root);
      expect(
        scene.operations.filter((op) => op.operation === "set" && op.field === "gainFocus"),
      ).toEqual([]);
      render(false);
      await settle(root);
      input.dispatch({ key: "select", phase: "up" });
      expect(press).not.toHaveBeenCalled();
      input.dispatch({ key: "select", phase: "down" });
      input.dispatch({ key: "select", phase: "up" });
      expect(press).toHaveBeenCalledTimes(1);
    } finally {
      root.unmount();
      input.dispose();
    }
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
  },
);
