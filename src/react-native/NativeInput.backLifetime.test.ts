import { createElement, useLayoutEffect, useSyncExternalStore } from "react";
import { expect, it, vi } from "vitest";
import { NativeInput } from "./NativeInput";
import { BackHandler } from "./environment";
import { createNativeRoot } from "./createNativeRoot";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import { RouterStore } from "../navigation/RouterStore";
import { RokuRouterProvider, useRouter } from "../navigation/expoRouter";

it("does not call a Back subscription removed by a newer handler during delivery", () => {
  const input = new NativeInput(),
    old = vi.fn(() => true),
    remove = input.addBackHandler(old);
  input.addBackHandler(() => {
    remove();
    return false;
  });
  try {
    expect(input.dispatch({ key: "back", phase: "down" })).toBe(false);
    expect(old).not.toHaveBeenCalled();
  } finally {
    input.dispose();
  }
});

it("keeps a repeated old removal from deleting a later registration of the same callback", () => {
  const input = new NativeInput(),
    handler = vi.fn(() => true),
    oldRemove = input.addBackHandler(handler);
  oldRemove();
  const currentRemove = input.addBackHandler(handler);
  oldRemove();
  try {
    expect(input.dispatch({ key: "back", phase: "down" })).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    currentRemove();
    expect(input.observerCount).toBe(0);
  } finally {
    input.dispose();
  }
});

it("waits until the next event for a removed callback re-registered during delivery", () => {
  const input = new NativeInput(),
    handler = vi.fn(() => true);
  let remove = input.addBackHandler(handler),
    replace = true;
  input.addBackHandler(() => {
    if (replace) {
      replace = false;
      remove();
      remove = input.addBackHandler(handler);
    }
    return false;
  });
  try {
    expect(input.dispatch({ key: "back", phase: "down" })).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(input.dispatch({ key: "back", phase: "down" })).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  } finally {
    input.dispose();
  }
});

it.each(["dispose", "inactive", "reactivated", "editor"] as const)(
  "stops the current Back delivery after %s retires the gesture",
  (kind) => {
    const input = new NativeInput(),
      old = vi.fn(() => true);
    input.addBackHandler(old);
    input.addBackHandler(() => {
      if (kind === "dispose") input.dispose();
      else if (kind === "editor") input.cancelPendingInput();
      else {
        input.setActive(false);
        if (kind === "reactivated") input.setActive(true);
      }
      return false;
    });
    try {
      expect(input.dispatch({ key: "back", phase: "down" })).toBe(true);
      expect(old).not.toHaveBeenCalled();
    } finally {
      input.dispose();
    }
  },
);

it("retains callback deduplication, LIFO priority, and consumption before older callbacks", () => {
  const input = new NativeInput(),
    calls: string[] = [],
    older = () => {
      calls.push("older");
      return true;
    };
  input.addBackHandler(older);
  const newer = input.addBackHandler(() => {
    calls.push("newer");
    return false;
  });
  const duplicate = input.addBackHandler(older);
  try {
    expect(input.dispatch({ key: "back", phase: "down" })).toBe(true);
    expect(calls).toEqual(["newer", "older"]);
    duplicate();
    newer();
    expect(input.observerCount).toBe(0);
  } finally {
    input.dispose();
  }
});

it("does not deliver a captured Back callback after its real React route has unmounted", async () => {
  const input = new NativeInput(),
    scene = new RecordingSceneGraph(),
    store = new RouterStore("/origin"),
    calls: string[] = [];
  const root = createNativeRoot(scene, {
    input,
    strictMode: true,
    viewport: { width: 300, height: 100 },
    text: { prepare() {}, metrics: () => ({ lineHeight: 20, width: () => 8 }) },
  });
  function Route({ path }: { path: string }) {
    const router = useRouter();
    useLayoutEffect(() => {
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        calls.push(path + ":back");
        router.replace("/stale");
        return true;
      });
      return () => {
        calls.push(path + ":cleanup");
        subscription.remove();
      };
    }, [router, path]);
    return null;
  }
  function App() {
    const route = useSyncExternalStore(store.subscribe, store.getSnapshot);
    return createElement(RokuRouterProvider, {
      store,
      children: createElement(Route, { key: route.key, path: route.pathname }),
    });
  }
  let current: { remove(): void } | undefined;
  try {
    root.render(createElement(App));
    await root.whenCommitted();
    calls.length = 0;
    current = BackHandler.addEventListener("hardwareBackPress", () => {
      store.replace("/successor");
      root.flush();
      expect(calls).toContain("/origin:cleanup");
      return false;
    });
    const handled = input.dispatch({ key: "back", phase: "down" });
    await root.whenCommitted();
    expect(store.getSnapshot().pathname).toBe("/successor");
    expect(calls).not.toContain("/origin:back");
    expect(calls).not.toContain("/successor:back");
    expect(handled).toBe(false);
  } finally {
    current?.remove();
    root.unmount();
    input.dispose();
  }
  expect(input.observerCount).toBe(0);
  expect(scene.listenerCount).toBe(0);
  expect(scene.nodes.size).toBe(1);
});
