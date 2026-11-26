import { createElement, createRef, type ReactNode } from "react";
import { expect, it } from "vitest";
import { createNativeRoot } from "./createNativeRoot";
import { NativeInput } from "./NativeInput";
import { Pressable, View } from "./primitives";
import { findNodeHandle, type NativeViewHandle } from "./nativeViewHandle";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";

const text = { prepare() {}, metrics: () => ({ lineHeight: 20, width: () => 0 }) };
const tile = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
  createElement(Pressable, {
    key: id,
    nativeID: id,
    style: { position: "absolute", left: x, top: y, width: 40, height: 40 },
    ...extra,
  });
function fixture() {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput();
  const root = createNativeRoot(scene, { input, text, viewport: { width: 640, height: 360 } });
  return {
    scene,
    input,
    async render(children: ReactNode) {
      root.render(createElement(View, { style: { width: 640, height: 360 } }, children));
      await root.whenCommitted();
      scene.operations.length = 0;
    },
    observe(id: string) {
      input.observeFocus(id, true);
    },
    requests: () =>
      scene.operations
        .filter((op) => op.field === "gainFocus")
        .map((op) => scene.nodes.get(op.node)!.fields.id),
    close() {
      root.unmount();
      input.dispose();
      expect(scene.nodes.size).toBe(1);
      expect(scene.listenerCount).toBe(0);
    },
  };
}

it.each(["up", "right", "down", "left"] as const)(
  "requests the committed spatial %s neighbor without fabricating focus",
  async (direction) => {
    const f = fixture();
    try {
      await f.render([
        tile("origin", 100, 100),
        tile("up", 100, 20),
        tile("right", 180, 100),
        tile("down", 100, 180),
        tile("left", 20, 100),
      ]);
      f.observe("origin");
      expect(f.input.dispatch({ key: direction, phase: "down" })).toBe(true);
      expect(f.requests()).toEqual([direction]);
      expect(f.input.focusedID).toBe("origin");
      f.observe(direction);
      expect(f.input.focusedID).toBe(direction);
    } finally {
      f.close();
    }
  },
);

it("keeps declared and imperative links ahead of geometry, including explicit stops and stale destinations", async () => {
  const f = fixture(),
    origin = createRef<NativeViewHandle>(),
    far = createRef<NativeViewHandle>();
  try {
    await f.render([
      tile("origin", 20, 100, { ref: origin }),
      tile("near", 100, 100),
      tile("far", 200, 100, { ref: far }),
    ]);
    await f.render([
      tile("origin", 20, 100, { ref: origin, nextFocusRight: findNodeHandle(far.current) }),
      tile("near", 100, 100),
      tile("far", 200, 100, { ref: far }),
    ]);
    f.observe("origin");
    f.input.dispatch({ key: "right", phase: "down" });
    expect(f.requests()).toEqual(["far"]);
    f.observe("far");
    f.observe("origin");
    f.scene.operations.length = 0;
    origin.current!.setNativeProps({ nextFocusRight: null });
    expect(f.input.dispatch({ key: "right", phase: "down" })).toBe(true);
    expect(f.requests()).toEqual([]);
    origin.current!.setNativeProps({ nextFocusRight: 999999 });
    f.input.dispatch({ key: "right", phase: "down" });
    expect(f.requests()).toEqual([]);
  } finally {
    f.close();
  }
});

it("skips disabled, hidden, nonfocusable, zero-area and modal-excluded candidates", async () => {
  const f = fixture();
  try {
    await f.render(
      createElement(View, { "aria-modal": true }, [
        tile("origin", 20, 100),
        tile("disabled", 70, 100, { disabled: true }),
        tile("hidden", 80, 100, { style: { display: "none" } }),
        tile("inert", 90, 100, { focusable: false }),
        tile("empty", 95, 100, {
          style: { position: "absolute", left: 95, top: 100, width: 0, height: 40 },
        }),
        tile("inside", 200, 100),
      ]),
    );
    // Outside is physically closer but belongs to the blocked background.
    await f.render([
      tile("outside", 100, 100),
      createElement(View, { key: "modal", "aria-modal": true }, [
        tile("origin", 20, 100),
        tile("disabled", 70, 100, { disabled: true }),
        tile("hidden", 80, 100, { style: { display: "none" } }),
        tile("inert", 90, 100, { focusable: false }),
        tile("empty", 95, 100, {
          style: { position: "absolute", left: 95, top: 100, width: 0, height: 40 },
        }),
        tile("inside", 200, 100),
      ]),
    ]);
    f.observe("origin");
    f.input.dispatch({ key: "right", phase: "down" });
    expect(f.requests()).toEqual(["inside"]);
  } finally {
    f.close();
  }
});

it("ranks aligned candidates deterministically and uses updated transformed bounds", async () => {
  const f = fixture();
  try {
    const render = (translation: number) =>
      f.render([
        tile("origin", 20, 100),
        tile("diagonal", 75, 10),
        tile("first", 150, 100, {
          style: {
            position: "absolute",
            left: 150,
            top: 100,
            width: 40,
            height: 40,
            transform: [{ translateX: translation }],
          },
        }),
        tile("second", 150, 100),
      ]);
    await render(0);
    f.observe("origin");
    f.input.dispatch({ key: "right", phase: "down" });
    expect(f.requests()).toEqual(["first"]);
    f.observe("first");
    f.observe("origin");
    await render(-250);
    f.input.dispatch({ key: "right", phase: "down" });
    expect(f.requests()).toEqual(["second"]);
  } finally {
    f.close();
  }
});

it("leaves a terminal direction unhandled and never treats a release as navigation", async () => {
  const f = fixture();
  try {
    await f.render([tile("origin", 20, 100), tile("right", 100, 100)]);
    f.observe("origin");
    expect(f.input.dispatch({ key: "left", phase: "down" })).toBe(false);
    expect(f.input.dispatch({ key: "right", phase: "up" })).toBe(false);
    expect(f.requests()).toEqual([]);
  } finally {
    f.close();
  }
});

it("lets a shared input observer own a direction and refuses navigation from a retired source", async () => {
  const f = fixture();
  try {
    await f.render([tile("origin", 20, 100), tile("right", 100, 100)]);
    f.observe("origin");
    const release = f.input.subscribe((event) => event.eventType === "right");
    expect(f.input.dispatch({ key: "right", phase: "down" })).toBe(true);
    expect(f.requests()).toEqual([]);
    release();
    await f.render([tile("origin", 20, 100, { disabled: true }), tile("right", 100, 100)]);
    expect(f.input.dispatch({ key: "right", phase: "down" })).toBe(false);
    expect(f.requests()).toEqual([]);
  } finally {
    f.close();
  }
});

it("retires a held Select on spatial movement and waits for observed focus before activation", async () => {
  const f = fixture(),
    activations: string[] = [];
  try {
    await f.render([
      tile("origin", 20, 100, { onPress: () => activations.push("origin") }),
      tile("right", 100, 100, { onPress: () => activations.push("right") }),
    ]);
    f.observe("origin");
    f.input.dispatch({ key: "select", phase: "down" });
    f.input.dispatch({ key: "right", phase: "down" });
    f.input.dispatch({ key: "select", phase: "up" });
    expect(f.requests()).toEqual(["right"]);
    expect(activations).toEqual([]);
    f.observe("right");
    f.input.dispatch({ key: "select", phase: "down" });
    f.input.dispatch({ key: "select", phase: "up" });
    expect(activations).toEqual(["right"]);
    f.input.setActive(false);
    f.scene.operations.length = 0;
    expect(f.input.dispatch({ key: "left", phase: "down" })).toBe(false);
    expect(f.requests()).toEqual([]);
  } finally {
    f.close();
  }
});

it("activates the observed destination once after a queued reversal and Select", async () => {
  const f = fixture();
  const activations: string[] = [];
  const labels = ["first", "second", "third", "fourth"];
  try {
    await f.render(
      labels.map((label, index) =>
        tile(label, 20 + index * 100, 100, { onPress: () => activations.push(label) }),
      ),
    );
    f.observe("first");
    for (const key of ["right", "right", "right", "left", "select"] as const) {
      expect(f.input.dispatch({ key, phase: "down" })).toBe(true);
      f.input.dispatch({ key, phase: "up" });
    }
    expect(f.requests()).toEqual(["second"]);
    for (const label of ["second", "third", "fourth"]) {
      f.observe(label);
      expect(activations).toEqual([]);
    }
    f.observe("third");
    expect(f.requests()).toEqual(["second", "third", "fourth", "third"]);
    expect(activations).toEqual(["third"]);
  } finally {
    f.close();
  }
});
