import { createElement, useLayoutEffect, useSyncExternalStore } from "react";
import { createNativeRoot, NativeInput } from "react-native-roku";
import { BackHandler } from "react-native";
import { RouterStore } from "react-native-roku/router";
import { RokuRouterProvider, useRouter } from "react-native-roku/expo-router";
import { RecordingSceneGraph } from "react-native-roku/testing";

/** Real mounted route cleanup and public Back subscriptions; synthetic input only. */
export async function qualifyBackLifetimes() {
  const demand = (condition: unknown, message: string) => {
    if (!condition) throw Error("Packed Back lifetime: " + message);
  };
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
      demand(
        calls.includes("/origin:cleanup"),
        "the old React owner must actually unmount before continuation",
      );
      return false;
    });
    demand(
      !input.dispatch({ key: "back", phase: "down" }),
      "removed and newly registered route callbacks must not consume the old event",
    );
    await root.whenCommitted();
    demand(
      store.getSnapshot().pathname === "/successor",
      "a removed callback must not navigate the current store",
    );
    demand(
      !calls.some((call) => call.endsWith(":back")),
      "retired and successor callbacks must not receive the captured event",
    );
  } finally {
    current?.remove();
    root.unmount();
    input.dispose();
  }
  demand(
    input.observerCount === 0 && scene.listenerCount === 0 && scene.nodes.size === 1,
    "route retirement must release input and scene bindings",
  );

  const standalone = new NativeInput();
  let delivered = 0;
  const callback = () => {
      delivered++;
      return true;
    },
    old = standalone.addBackHandler(callback);
  try {
    old();
    const fresh = standalone.addBackHandler(callback);
    old();
    demand(
      standalone.dispatch({ key: "back", phase: "down" }) && delivered === 1,
      "stale removal must not own a later registration",
    );
    fresh();
    demand(standalone.observerCount === 0, "fresh removal must own the fresh registration");
  } finally {
    standalone.dispose();
  }
  const retiredGestures = [];
  for (const kind of ["dispose", "inactive", "reactivated", "editor"] as const) {
    const port = new NativeInput();
    let stale = 0;
    port.addBackHandler(() => {
      stale++;
      return true;
    });
    port.addBackHandler(() => {
      if (kind === "dispose") port.dispose();
      else if (kind === "editor") port.cancelPendingInput();
      else {
        port.setActive(false);
        if (kind === "reactivated") port.setActive(true);
      }
      return false;
    });
    try {
      demand(
        port.dispatch({ key: "back", phase: "down" }) && stale === 0,
        "gesture retirement must stop older callbacks: " + kind,
      );
      retiredGestures.push(kind);
    } finally {
      port.dispose();
    }
  }
  return {
    route: store.getSnapshot().pathname,
    mountedCleanup: true,
    staleCallbacks: 0,
    replacementDelivered: delivered,
    retiredGestures,
    retired: true,
  };
}
