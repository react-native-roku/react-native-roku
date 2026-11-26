import { createElement, createRef, Fragment, useState, useSyncExternalStore } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createNativeRoot } from "./createNativeRoot";
import { Modal } from "./modal";
import { View, Text, Pressable } from "./primitives";
import { NativeInput } from "./NativeInput";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import { RouterStore } from "../navigation/RouterStore";
import { RokuRouterProvider, useRouter } from "../navigation/expoRouter";
import { TextInput, type NativeTextInputHandle } from "./textInput";
import type { NativeViewHandle } from "./nativeViewHandle";
import { Keyboard } from "./nativeModules";

const text = {
  prepare() {},
  metrics: () => ({ lineHeight: 20, width: (value: string) => value.length * 8 }),
};
const settle = async (root: ReturnType<typeof createNativeRoot>) => {
  for (let index = 0; index < 4; index++) {
    await root.whenCommitted();
    root.flush();
  }
};
afterEach(() => vi.useRealTimers());

it("retires a closing modal editor while its former return target and held key disappear", async () => {
  vi.useFakeTimers();
  const scene = new RecordingSceneGraph(),
    input = new NativeInput();
  const background = createRef<NativeViewHandle>(),
    editor = createRef<NativeTextInputHandle>();
  const changes: string[] = [],
    presses: string[] = [];
  let finish!: (value: string | null) => void, observed!: (closed: boolean) => void;
  let closes = 0,
    opens = 0,
    hides = 0,
    dismissals = 0;
  let retire: () => void = () => {
    throw Error("No committed route");
  };
  let returnTarget: NativeViewHandle | null = null;
  const root = createNativeRoot(scene, {
    input,
    text,
    strictMode: true,
    viewport: { width: 800, height: 600 },
    textEntry: {
      open() {
        opens++;
        return {
          result: new Promise<string | null>((resolve) => {
            finish = resolve;
          }),
          closed: new Promise<boolean>((resolve) => {
            observed = resolve;
          }),
          close() {
            closes++;
          },
        };
      },
    },
  });
  const hide = Keyboard.addListener("keyboardDidHide", () => hides++);
  function App() {
    const [visible, setVisible] = useState(true),
      [backgroundVisible, setBackgroundVisible] = useState(true);
    retire = () => {
      setVisible(false);
      setBackgroundVisible(false);
    };
    return createElement(
      Fragment,
      {},
      backgroundVisible
        ? createElement(Pressable, {
            ref: background,
            nativeID: "return-target",
            style: { width: 100, height: 40 },
          })
        : null,
      createElement(
        Modal,
        {
          visible,
          animationType: "fade",
          onDismiss() {
            dismissals++;
            returnTarget?.requestTVFocus();
          },
        },
        createElement(Pressable, {
          nativeID: "held-control",
          style: { width: 100, height: 40 },
          onPress: () => presses.push("retired"),
        }),
        createElement(TextInput, { ref: editor, onChangeText: (value) => changes.push(value) }),
      ),
    );
  }
  const advance = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    await settle(root);
  };
  try {
    root.render(createElement(App));
    await settle(root);
    await advance(320);
    returnTarget = background.current;
    const retiredEditor = editor.current!;
    const held = [...scene.nodes.values()].find((node) => node.fields.id === "held-control")!;
    scene.emit(held, "focusedChild", "held-control");
    input.dispatch({ key: "select", phase: "down" });
    retiredEditor.focus();
    expect(opens).toBe(1);
    const requestedBefore = scene.operations.filter(
      (operation) => operation.field === "gainFocus" && operation.value === true,
    ).length;
    root.runSync(retire);
    await settle(root);
    await advance(100);
    expect(closes).toBe(0);
    expect(hides).toBe(0);
    expect(dismissals).toBe(0);
    await advance(240);
    expect(closes).toBe(1);
    expect(dismissals).toBe(1);
    expect(hides).toBe(0);
    expect(
      scene.operations.filter(
        (operation) => operation.field === "gainFocus" && operation.value === true,
      ),
    ).toHaveLength(requestedBefore);
    finish("retired result");
    observed(true);
    await settle(root);
    expect(changes).toEqual([]);
    // The editor has retired: its late close observation cannot publish a
    // keyboard event to a later owner, even though the root remains mounted.
    expect(hides).toBe(0);
    retiredEditor.focus();
    expect(opens).toBe(1);
    scene.emit(held, "focusedChild", "held-control");
    input.dispatch({ key: "select", phase: "up" });
    expect(presses).toEqual([]);
    expect(input.focusedID).toBeNull();
    expect(input.targetCount).toBe(0);
  } finally {
    hide.remove();
    root.unmount();
    input.dispose();
  }
  expect(scene.nodes.size).toBe(1);
  expect(scene.listenerCount).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("gives Back to the top committed nested modal and releases each retired owner", async () => {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput(),
    close: string[] = [];
  const root = createNativeRoot(scene, {
    input,
    text,
    strictMode: true,
    viewport: { width: 800, height: 600 },
  });
  function App() {
    const [outer, setOuter] = useState(true),
      [inner, setInner] = useState(true);
    return createElement(
      Modal,
      {
        visible: outer,
        onRequestClose: () => {
          close.push("outer");
          setOuter(false);
        },
      },
      createElement(Text, {}, "Outer"),
      createElement(
        Modal,
        {
          visible: inner,
          onRequestClose: () => {
            close.push("inner");
            setInner(false);
          },
        },
        createElement(Text, {}, "Inner"),
      ),
    );
  }
  try {
    root.render(createElement(App));
    await settle(root);
    input.dispatch({ key: "back", phase: "down" });
    await settle(root);
    expect(close).toEqual(["inner"]);
    input.dispatch({ key: "back", phase: "up" });
    input.dispatch({ key: "back", phase: "down" });
    await settle(root);
    expect(close).toEqual(["inner", "outer"]);
    expect(input.observerCount).toBe(0);
  } finally {
    root.unmount();
    input.dispose();
  }
  expect(scene.nodes.size).toBe(1);
  expect(scene.listenerCount).toBe(0);
});

it.each(["fade", "slide"] as const)(
  "retires route-owned pending %s portals, callbacks and held input across returns",
  async (animationType) => {
    vi.useFakeTimers();
    const scene = new RecordingSceneGraph(),
      input = new NativeInput(),
      store = new RouterStore("/a");
    const calls: string[] = [];
    let reopen: () => void = () => {
      throw Error("No mounted modal");
    };
    const root = createNativeRoot(scene, {
      input,
      text,
      strictMode: true,
      viewport: { width: 800, height: 600 },
    });
    function Route({ path }: { path: string }) {
      const router = useRouter();
      const [visible, setVisible] = useState(true);
      reopen = () => setVisible(true);
      return createElement(
        View,
        {},
        createElement(Pressable, {
          nativeID: "route-control",
          onPress: () => calls.push(path + ":press"),
          style: { width: 100, height: 40 },
        }),
        createElement(
          Modal,
          {
            visible,
            animationType,
            onShow: () => calls.push(path + ":show"),
            onDismiss: () => calls.push(path + ":dismiss"),
            onRequestClose: () => {
              calls.push(path + ":back");
              setVisible(false);
            },
          },
          createElement(Pressable, {
            nativeID: "modal-control",
            style: { width: 100, height: 40 },
            onPress: () => router.push("/from-modal"),
          }),
        ),
      );
    }
    function App() {
      const route = useSyncExternalStore(store.subscribe, store.getSnapshot);
      return createElement(RokuRouterProvider, {
        store,
        children: createElement(Route, { key: route.key, path: route.pathname }),
      });
    }
    const advance = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      await settle(root);
    };
    try {
      root.render(createElement(App));
      await settle(root);
      await advance(48);
      const retiredNode = [...scene.nodes.values()].find(
        (node) => node.fields.id === "modal-control",
      )!;
      scene.emit(retiredNode, "focusedChild", "modal-control");
      input.dispatch({ key: "select", phase: "down" });
      root.runSync(() => store.replace("/b"));
      await settle(root);
      root.runSync(() => store.replace("/a"));
      await settle(root);
      scene.emit(retiredNode, "focusedChild", "modal-control");
      input.dispatch({ key: "select", phase: "up" });
      expect(store.getSnapshot().pathname).toBe("/a");
      await advance(320);
      expect(calls.filter((value) => value.endsWith(":show"))).toEqual(["/a:show"]);
      expect(calls).not.toContain("/b:show");
      expect(calls).not.toContain("/a:press");
      input.dispatch({ key: "back", phase: "down" });
      await settle(root);
      await advance(100);
      root.runSync(reopen);
      await settle(root);
      await advance(48);
      input.dispatch({ key: "back", phase: "up" });
      input.dispatch({ key: "back", phase: "down" });
      await settle(root);
      expect(calls.filter((value) => value.endsWith(":back"))).toHaveLength(2);
      await advance(320);
      expect(
        [...scene.nodes.values()].filter((node) =>
          String(node.fields.id).startsWith("roku-modal-"),
        ),
      ).toHaveLength(0);
      expect(input.observerCount).toBe(0);
    } finally {
      root.unmount();
      input.dispose();
      store.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
    expect(store.listenerCount).toBe(0);
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
  },
);
