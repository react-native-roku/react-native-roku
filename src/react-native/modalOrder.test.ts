import { createElement, Fragment } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Modal } from "./modal";
import { Pressable } from "./primitives";
import { createNativeRoot } from "./createNativeRoot";
import { NativeInput } from "./NativeInput";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";

const text = { prepare() {}, metrics: () => ({ lineHeight: 20, width: () => 8 }) };
function fixture(animationType: "none" | "fade" | "slide" = "none") {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput(),
    closed: string[] = [];
  const root = createNativeRoot(scene, {
    input,
    text,
    strictMode: true,
    viewport: { width: 800, height: 600 },
  });
  const settle = async () => {
    for (let index = 0; index < 5; index++) {
      await root.whenCommitted();
      root.flush();
    }
  };
  const control = (id: string) =>
    createElement(Pressable, { nativeID: id, style: { width: 100, height: 40 } });
  const render = async (a: boolean, b: boolean, nested = false) => {
    root.render(
      createElement(
        Fragment,
        {},
        createElement(
          Modal,
          { key: "a", visible: a, animationType, onRequestClose: () => closed.push("a") },
          control("a-control"),
          createElement(
            Modal,
            { visible: nested, animationType, onRequestClose: () => closed.push("nested") },
            control("nested-control"),
          ),
        ),
        createElement(
          Modal,
          { key: "b", visible: b, animationType, onRequestClose: () => closed.push("b") },
          control("b-control"),
        ),
      ),
    );
    await settle();
  };
  const back = () => {
    input.dispatch({ key: "back", phase: "down" });
    input.dispatch({ key: "back", phase: "up" });
  };
  const advance = async (time: number) => {
    await vi.advanceTimersByTimeAsync(time);
    await settle();
  };
  const dispose = () => {
    root.unmount();
    input.dispose();
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
    expect(input.observerCount).toBe(0);
  };
  return { root, scene, input, closed, render, back, advance, dispose };
}
afterEach(() => vi.useRealTimers());

it.each([0x4d0da1, 0x5a1c0e])(
  "replays sibling presentation order independently of mount identity (seed=%s)",
  async (seed) => {
    const f = fixture(),
      visible = { a: false, b: false },
      stack: ("a" | "b")[] = [],
      trace: unknown[] = [];
    const random = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    try {
      await f.render(false, false);
      for (let step = 0; step < 96; step++) {
        const name = random() % 2 === 0 ? "a" : "b",
          next = random() % 3 !== 0;
        if (visible[name] !== next) {
          visible[name] = next;
          const index = stack.indexOf(name);
          if (index >= 0) stack.splice(index, 1);
          if (next) stack.push(name);
        }
        trace.push({ name, next, stack: [...stack] });
        await f.render(visible.a, visible.b);
        const before = f.closed.length,
          top = stack.at(-1);
        f.back();
        expect(f.closed.slice(before)).toEqual(top ? [top] : []);
        for (const owner of ["a", "b"] as const)
          expect(f.input.isTargetEnabled(owner + "-control")).toBe(owner === top);
      }
    } catch (error) {
      throw Error("Modal presentation replay " + JSON.stringify(trace), { cause: error });
    } finally {
      f.dispose();
    }
  },
);

it("presents a previously hidden earlier sibling above the already visible modal", async () => {
  const f = fixture();
  try {
    await f.render(false, true);
    expect(f.input.isTargetEnabled("b-control")).toBe(true);
    await f.render(true, true);
    expect(f.input.isTargetEnabled("a-control")).toBe(true);
    expect(f.input.isTargetEnabled("b-control")).toBe(false);
    f.back();
    expect(f.closed).toEqual(["a"]);
    await f.render(false, true);
    expect(f.input.isTargetEnabled("b-control")).toBe(true);
    await f.render(true, true);
    f.back();
    expect(f.closed).toEqual(["a", "a"]);
  } finally {
    f.dispose();
  }
});

it.each(["fade", "slide"] as const)(
  "retains nested presentation order across a %s reversal and raises a fully reopened sibling",
  async (animation) => {
    vi.useFakeTimers();
    const f = fixture(animation);
    try {
      await f.render(true, false, true);
      await f.advance(320);
      f.back();
      expect(f.closed).toEqual(["nested"]);
      await f.render(false, false, true);
      await f.advance(96);
      await f.render(true, false, true);
      await f.advance(320);
      expect(f.input.isTargetEnabled("nested-control")).toBe(true);
      f.back();
      expect(f.closed).toEqual(["nested", "nested"]);
      await f.render(false, false);
      await f.advance(320);
      await f.render(false, true);
      await f.advance(320);
      await f.render(true, true);
      await f.advance(320);
      expect(f.input.isTargetEnabled("a-control")).toBe(true);
      f.back();
      expect(f.closed.at(-1)).toBe("a");
    } finally {
      f.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);
