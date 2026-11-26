import { createElement, useLayoutEffect, useSyncExternalStore } from "react";
import { expect, it, vi } from "vitest";
import { NativeInput } from "./NativeInput";
import { createNativeRoot } from "./createNativeRoot";
import { View, Pressable } from "./primitives";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import { RouterStore } from "../navigation/RouterStore";
import { RokuRouterProvider, useRouter } from "../navigation/expoRouter";

const target = () => ({ enabled: () => true, focus: vi.fn(), pressed: vi.fn(), activate: vi.fn() });

for (const phase of ["pressed", "blur"] as const) {
  it(`does not restore observed focus after disposal from ${phase}`, () => {
    const input = new NativeInput(),
      first = target(),
      second = target();
    input.register("first", first);
    input.register("second", second);
    input.observeFocus("first", true);
    if (phase === "pressed") {
      first.pressed.mockImplementation((pressed) => {
        if (!pressed) input.dispose();
      });
      input.dispatch({ key: "select", phase: "down" });
    } else
      first.focus.mockImplementation((focused) => {
        if (!focused) input.dispose();
      });
    input.observeFocus("second", true);
    expect(input.focusedID).toBeNull();
    expect(second.focus).not.toHaveBeenCalledWith(true);
    expect(input.targetCount).toBe(0);
  });
}

for (const phase of ["pressed", "blur"] as const) {
  it(`preserves a newer explicit focus observation from ${phase}`, () => {
    const input = new NativeInput(),
      first = target(),
      second = target(),
      third = target();
    input.register("first", first);
    input.register("second", second);
    input.register("third", third);
    input.observeFocus("first", true);
    if (phase === "pressed") {
      first.pressed.mockImplementation((pressed) => {
        if (!pressed) input.observeFocus("third", true);
      });
      input.dispatch({ key: "select", phase: "down" });
    } else
      first.focus.mockImplementation((focused) => {
        if (!focused) input.observeFocus("third", true);
      });
    input.observeFocus("second", true);
    expect(input.focusedID).toBe("third");
    expect(second.focus).not.toHaveBeenCalledWith(true);
    expect(third.focus).toHaveBeenCalledExactlyOnceWith(true);
    input.dispose();
  });
}

it("does not acknowledge a replacement route from an observation of its retired same-ID target", async () => {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput(),
    store = new RouterStore("/origin"),
    calls: string[] = [];
  const root = createNativeRoot(scene, {
    input,
    viewport: { width: 300, height: 100 },
    text: { prepare() {}, metrics: () => ({ lineHeight: 20, width: () => 8 }) },
  });
  function Route({ path }: { path: string }) {
    const router = useRouter();
    useLayoutEffect(
      () => () => {
        calls.push(path + ":cleanup");
      },
      [path],
    );
    return createElement(
      View,
      {},
      path === "/origin"
        ? createElement(Pressable, {
            nativeID: "first",
            onBlur() {
              router.replace("/successor");
              root.flush();
            },
          })
        : null,
      createElement(Pressable, { nativeID: "second", onFocus: () => calls.push(path + ":focus") }),
    );
  }
  function App() {
    const route = useSyncExternalStore(store.subscribe, store.getSnapshot);
    return createElement(RokuRouterProvider, {
      store,
      children: createElement(Route, { key: route.key, path: route.pathname }),
    });
  }
  try {
    root.render(createElement(App));
    await root.whenCommitted();
    const first = [...scene.nodes.values()].find((node) => node.fields.id === "first")!;
    const old = [...scene.nodes.values()].find((node) => node.fields.id === "second")!;
    scene.emit(first, "focusedChild", "first");
    scene.emit(old, "focusedChild", "second");
    await root.whenCommitted();
    expect(store.getSnapshot().pathname).toBe("/successor");
    expect(calls).toContain("/origin:cleanup");
    expect(calls.filter((call) => call.endsWith(":focus"))).toEqual([]);
    expect(input.focusedID).toBeNull();
    const current = [...scene.nodes.values()].find((node) => node.fields.id === "second")!;
    expect(current).not.toBe(old);
    scene.emit(current, "focusedChild", "second");
    expect(calls.filter((call) => call.endsWith(":focus"))).toEqual(["/successor:focus"]);
  } finally {
    root.unmount();
    input.dispose();
    store.dispose();
  }
  expect(scene.nodes.size).toBe(1);
  expect(scene.listenerCount).toBe(0);
  expect(input.targetCount).toBe(0);
});

it("keeps a newer focus observation made during held-key focus loss", () => {
  const input = new NativeInput(),
    first = target(),
    second = target();
  input.register("first", first);
  input.register("second", second);
  input.observeFocus("first", true);
  first.pressed.mockImplementation((pressed) => {
    if (!pressed) input.observeFocus("second", true);
  });
  input.dispatch({ key: "select", phase: "down" });
  input.observeFocus("first", false);
  expect(input.focusedID).toBe("second");
  expect(second.focus).toHaveBeenCalledExactlyOnceWith(true);
  expect(first.focus.mock.calls).toEqual([[true], [false]]);
  input.dispose();
});

it("still accepts a live destination when cancellation removes only the departing target", () => {
  const input = new NativeInput(),
    first = target(),
    second = target();
  const remove = input.register("first", first);
  input.register("second", second);
  input.observeFocus("first", true);
  first.pressed.mockImplementation((pressed) => {
    if (!pressed) remove();
  });
  input.dispatch({ key: "select", phase: "down" });
  input.observeFocus("second", true);
  expect(input.focusedID).toBe("second");
  expect(second.focus).toHaveBeenCalledExactlyOnceWith(true);
  expect(first.focus.mock.calls).toEqual([[true]]);
  input.dispose();
});

for (const transition of ["editor", "reactivation"] as const) {
  it(`keeps a valid focus observation separate from ${transition} gesture cancellation`, () => {
    const input = new NativeInput(),
      first = target(),
      second = target();
    input.register("first", first);
    input.register("second", second);
    input.observeFocus("first", true);
    first.focus.mockImplementation((focused) => {
      if (focused) return;
      if (transition === "editor") input.cancelPendingInput();
      else {
        input.setActive(false);
        input.setActive(true);
      }
    });
    input.observeFocus("second", true);
    expect(input.focusedID).toBe("second");
    expect(second.focus).toHaveBeenCalledExactlyOnceWith(true);
    input.dispose();
  });
}

it("does not duplicate a newer observation that returns to the original destination", () => {
  const input = new NativeInput(),
    first = target(),
    second = target(),
    third = target();
  input.register("first", first);
  input.register("second", second);
  input.register("third", third);
  input.observeFocus("first", true);
  first.focus.mockImplementation((focused) => {
    if (!focused) {
      input.observeFocus("third", true);
      input.observeFocus("second", true);
    }
  });
  input.observeFocus("second", true);
  expect(input.focusedID).toBe("second");
  expect(second.focus.mock.calls).toEqual([[false], [true]]);
  input.dispose();
});

it("does not blur a fresh same-ID observation after held-key cancellation returns to it", () => {
  const input = new NativeInput(),
    first = target(),
    second = target();
  input.register("first", first);
  input.register("second", second);
  input.observeFocus("first", true);
  first.pressed.mockImplementation((pressed) => {
    if (!pressed) {
      input.observeFocus("second", true);
      input.observeFocus("first", true);
    }
  });
  input.dispatch({ key: "select", phase: "down" });
  input.observeFocus("first", false);
  expect(input.focusedID).toBe("first");
  expect(first.focus.mock.calls).toEqual([[true], [false], [true]]);
  input.dispose();
});
