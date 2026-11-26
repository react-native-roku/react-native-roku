import { createContext, createElement, useContext } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createNativeRoot } from "./createNativeRoot";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import { NativeInput } from "./NativeInput";
import { Modal } from "./modal";
import { View, Text } from "./primitives";
const text = {
  prepare() {},
  metrics: () => ({
    lineHeight: 20,
    width: (value: string) => value.length * 10,
  }),
};
afterEach(() => vi.useRealTimers());

it("replays StrictMode effects without fabricating a dismissal or duplicating Back ownership", async () => {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput();
  const root = createNativeRoot(scene, {
    text,
    input,
    strictMode: true,
    viewport: { width: 800, height: 600 },
  });
  const dismissed = vi.fn(),
    shown = vi.fn(),
    close = vi.fn();
  const render = (visible: boolean) =>
    root.render(
      createElement(
        Modal,
        { visible, onShow: shown, onDismiss: dismissed, onRequestClose: close },
        createElement(Text, {}, "Strict modal"),
      ),
    );
  try {
    render(true);
    await root.whenCommitted();
    expect(dismissed).not.toHaveBeenCalled();
    expect(shown).toHaveBeenCalledTimes(1);
    input.dispatch({ key: "back", phase: "down" });
    expect(close).toHaveBeenCalledTimes(1);
    render(false);
    await root.whenCommitted();
    expect(dismissed).toHaveBeenCalledTimes(1);
    expect(input.observerCount).toBe(0);
  } finally {
    root.unmount();
    input.dispose();
  }
  expect(scene.nodes.size).toBe(1);
});

it("routes Back to the containing Modal when its dialog scopes accessibility", async () => {
  const scene = new RecordingSceneGraph();
  const input = new NativeInput();
  const root = createNativeRoot(scene, { text, input, viewport: { width: 800, height: 600 } });
  const close = vi.fn();
  const backgroundBack = vi.fn(() => true);
  const remove = input.addBackHandler(backgroundBack);
  try {
    root.render(
      createElement(
        Modal,
        { transparent: true, onRequestClose: close },
        createElement(
          View,
          { nativeID: "dialog", accessibilityViewIsModal: true },
          createElement(Text, {}, "Route information"),
        ),
      ),
    );
    await root.whenCommitted();
    expect(input.dispatch({ key: "back", phase: "down" })).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(backgroundBack).not.toHaveBeenCalled();
  } finally {
    remove();
    root.unmount();
    input.dispose();
  }
});

it.each(["fade", "slide"] as const)(
  "executes %s transitions and cancels a closing transition on reopen",
  async (animationType) => {
    vi.useFakeTimers();
    const scene = new RecordingSceneGraph(),
      input = new NativeInput();
    const root = createNativeRoot(scene, { text, input, viewport: { width: 800, height: 600 } });
    const shown = vi.fn(),
      dismissed = vi.fn(),
      close = vi.fn();
    const render = (visible: boolean) =>
      root.render(
        createElement(
          Modal,
          {
            visible,
            animationType,
            onShow: shown,
            onDismiss: dismissed,
            onRequestClose: close,
          },
          createElement(Text, {}, "Animated modal"),
        ),
      );
    const modal = () =>
      scene.root.children.find((node) => String(node.fields.id).startsWith("roku-modal-"));
    const advance = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      root.flush();
      await root.whenCommitted();
    };
    try {
      render(true);
      await root.whenCommitted();
      await advance(144);
      if (animationType === "fade") {
        expect(modal()?.fields.opacity).toBeGreaterThan(0);
        expect(modal()?.fields.opacity).toBeLessThan(1);
      } else {
        const y = (modal()?.fields.translation as number[])[1];
        expect(y).toBeGreaterThan(0);
        expect(y).toBeLessThan(600);
      }
      expect(shown).not.toHaveBeenCalled();
      await advance(176);
      expect(shown).toHaveBeenCalledTimes(1);
      render(false);
      await root.whenCommitted();
      await advance(144);
      expect(modal()).toBeDefined();
      expect(dismissed).not.toHaveBeenCalled();
      input.dispatch({ key: "back", phase: "down" });
      expect(close).toHaveBeenCalledTimes(1);
      render(true);
      await root.whenCommitted();
      await advance(320);
      expect(shown).toHaveBeenCalledTimes(2);
      expect(dismissed).not.toHaveBeenCalled();
      render(false);
      await root.whenCommitted();
      await advance(320);
      expect(modal()).toBeUndefined();
      expect(dismissed).toHaveBeenCalledTimes(1);
      input.dispatch({ key: "back", phase: "up" });
      input.dispatch({ key: "back", phase: "down" });
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      root.unmount();
      input.dispose();
    }
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("retires an opening modal without a late show callback or animation timer", async () => {
  vi.useFakeTimers();
  const scene = new RecordingSceneGraph(),
    input = new NativeInput();
  const root = createNativeRoot(scene, { text, input, viewport: { width: 800, height: 600 } });
  const shown = vi.fn(),
    dismissed = vi.fn();
  root.render(createElement(Modal, { animationType: "fade", onShow: shown, onDismiss: dismissed }));
  await root.whenCommitted();
  await vi.advanceTimersByTimeAsync(32);
  root.unmount();
  input.dispose();
  await vi.advanceTimersByTimeAsync(500);
  expect(shown).not.toHaveBeenCalled();
  expect(dismissed).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(scene.nodes.size).toBe(1);
  expect(scene.listenerCount).toBe(0);
});

it("portals a modal outside clipped layout, preserves React context and retires Back ownership", async () => {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput();
  const root = createNativeRoot(scene, {
    text,
    input,
    viewport: { width: 800, height: 600 },
  });
  const context = createContext("missing"),
    shown = vi.fn(),
    closed = vi.fn(),
    dismissed = vi.fn();
  function Child() {
    return createElement(Text, {}, useContext(context));
  }
  const render = (visible: boolean) =>
    root.render(
      createElement(
        context.Provider,
        { value: "original context" },
        createElement(
          View,
          {
            nativeID: "clipped",
            style: { width: 100, height: 50, overflow: "hidden" },
          },
          createElement(
            Modal,
            {
              visible,
              onShow: () => shown(),
              onRequestClose: () => closed(),
              onDismiss: () => dismissed(),
            },
            createElement(Child),
          ),
        ),
      ),
    );
  try {
    render(true);
    await root.whenCommitted();
    const modal = scene.root.children.find((node) =>
      String(node.fields.id).startsWith("roku-modal-"),
    );
    expect(modal, JSON.stringify(scene.snapshot())).toBeDefined();
    expect(modal?.fields).toMatchObject({ translation: [0, 0] });
    expect(modal?.children[0].fields).toMatchObject({
      width: 800,
      height: 600,
    });
    expect([...scene.nodes.values()].some((node) => node.fields.text === "original context")).toBe(
      true,
    );
    expect(scene.root.children.at(-1)).toBe(modal);
    expect(shown).toHaveBeenCalledTimes(1);
    render(true);
    await root.whenCommitted();
    expect(shown).toHaveBeenCalledTimes(1);
    expect(dismissed).not.toHaveBeenCalled();
    input.dispatch({ key: "back", phase: "down" });
    expect(closed).toHaveBeenCalledTimes(1);
    render(false);
    await root.whenCommitted();
    expect(dismissed).toHaveBeenCalledTimes(1);
    input.dispatch({ key: "back", phase: "up" });
    input.dispatch({ key: "back", phase: "down" });
    expect(closed).toHaveBeenCalledTimes(1);
  } finally {
    root.unmount();
    input.dispose();
  }
  expect(scene.nodes.size).toBe(1);
  expect(scene.listenerCount).toBe(0);
});
