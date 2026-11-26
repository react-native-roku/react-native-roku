import { createElement, useLayoutEffect, useSyncExternalStore } from "react";
import { createNativeRoot, NativeInput } from "react-native-roku";
import { Pressable, View } from "react-native";
import { RouterStore } from "react-native-roku/router";
import { RokuRouterProvider, useRouter } from "react-native-roku/expo-router";
import { RecordingSceneGraph } from "react-native-roku/testing";

/** Callback ownership, independently observed from native focus requests. */
export async function qualifyFocusObservationLifetimes() {
  const demand = (condition: unknown, message: string) => {
    if (!condition) throw Error("Packed focus lifetime: " + message);
  };
  const transitions = [];
  for (const phase of ["pressed", "blur"] as const) {
    for (const transition of ["dispose", "observe"] as const) {
      const input = new NativeInput(),
        calls: string[] = [];
      const move = () => {
        if (transition === "dispose") input.dispose();
        else input.observeFocus("third", true);
      };
      const first = {
        enabled: () => true,
        activate() {},
        focus(value: boolean) {
          if (!value && phase === "blur") move();
        },
        pressed(value: boolean) {
          if (!value && phase === "pressed") move();
        },
      };
      const other = (name: string) => ({
        enabled: () => true,
        activate() {},
        pressed() {},
        focus(value: boolean) {
          if (value) calls.push(name);
        },
      });
      input.register("first", first);
      input.register("second", other("second"));
      input.register("third", other("third"));
      try {
        input.observeFocus("first", true);
        if (phase === "pressed") input.dispatch({ key: "select", phase: "down" });
        input.observeFocus("second", true);
        demand(
          input.focusedID === (transition === "dispose" ? null : "third"),
          "newer focus ownership must survive " + phase + "/" + transition,
        );
        demand(
          calls.join(",") === (transition === "dispose" ? "" : "third"),
          "retired destinations must not receive focus callbacks",
        );
        transitions.push({ phase, transition, calls });
      } finally {
        input.dispose();
      }
    }
  }
  const gestureControls = [];
  for (const transition of ["editor", "reactivation"] as const) {
    const port = new NativeInput();
    let received = 0;
    port.register("first", {
      enabled: () => true,
      activate() {},
      pressed() {},
      focus(focused) {
        if (focused) return;
        if (transition === "editor") port.cancelPendingInput();
        else {
          port.setActive(false);
          port.setActive(true);
        }
      },
    });
    port.register("second", {
      enabled: () => true,
      activate() {},
      pressed() {},
      focus(focused) {
        if (focused) received++;
      },
    });
    try {
      port.observeFocus("first", true);
      port.observeFocus("second", true);
      demand(
        port.focusedID === "second" && received === 1,
        "focus facts must remain separate from gesture cancellation",
      );
      gestureControls.push(transition);
    } finally {
      port.dispose();
    }
  }
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
    const first = [...scene.nodes.values()].find((node) => node.fields.id === "first")!,
      old = [...scene.nodes.values()].find((node) => node.fields.id === "second")!;
    scene.emit(first, "focusedChild", "first");
    scene.emit(old, "focusedChild", "second");
    await root.whenCommitted();
    demand(
      store.getSnapshot().pathname === "/successor" && calls.includes("/origin:cleanup"),
      "the original React route must actually retire",
    );
    demand(
      !calls.some((call) => call.endsWith(":focus")) && input.focusedID === null,
      "an old native observation must not acknowledge the successor route",
    );
    const current = [...scene.nodes.values()].find((node) => node.fields.id === "second")!;
    demand(current !== old, "the target must have a new native owner");
    scene.emit(current, "focusedChild", "second");
    demand(
      calls.filter((call) => call.endsWith(":focus")).join(",") === "/successor:focus",
      "the successor's own observation must still arrive once",
    );
  } finally {
    root.unmount();
    input.dispose();
    store.dispose();
  }
  demand(
    scene.nodes.size === 1 && scene.listenerCount === 0 && input.targetCount === 0,
    "all route/input ownership must retire",
  );
  return {
    transitions,
    gestureControls,
    route: "/successor",
    freshObservation: true,
    cleanup: true,
    scope:
      "Actual mounted React routes and explicit synthetic input observations; native focus/timing remain pending",
  };
}
