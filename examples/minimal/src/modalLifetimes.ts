import { createElement, useState } from "react";
import { createNativeRoot, NativeInput } from "react-native-roku";
import { Modal, Text } from "react-native";
import { RecordingSceneGraph } from "react-native-roku/testing";
import { ModalOrderFixture, type ModalOrderFixtureAPI } from "./modalOrderFixture";

/** Real mounted modal ownership through the public installed package. */
export async function qualifyModalLifetimes() {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput(),
    closed: string[] = [];
  const root = createNativeRoot(scene, {
    input,
    strictMode: true,
    viewport: { width: 800, height: 600 },
    text: {
      prepare() {},
      metrics: () => ({ lineHeight: 20, width: (value: string) => value.length * 8 }),
    },
  });
  function App() {
    const [outer, setOuter] = useState(true),
      [inner, setInner] = useState(true);
    return createElement(
      Modal,
      {
        visible: outer,
        onRequestClose: () => {
          closed.push("outer");
          setOuter(false);
        },
      },
      createElement(Text, {}, "Outer"),
      createElement(
        Modal,
        {
          visible: inner,
          onRequestClose: () => {
            closed.push("inner");
            setInner(false);
          },
        },
        createElement(Text, {}, "Inner"),
      ),
    );
  }
  try {
    root.render(createElement(App));
    await root.whenCommitted();
    input.dispatch({ key: "back", phase: "down" });
    await root.whenCommitted();
    if (JSON.stringify(closed) !== '["inner"]')
      throw Error("Packed nested modal gave Back to its parent");
    input.dispatch({ key: "back", phase: "up" });
    input.dispatch({ key: "back", phase: "down" });
    await root.whenCommitted();
    if (JSON.stringify(closed) !== '["inner","outer"]' || input.observerCount !== 0)
      throw Error("Packed modal failed to release its retired Back owner");
  } finally {
    root.unmount();
    input.dispose();
  }
  if (scene.nodes.size !== 1 || scene.listenerCount !== 0)
    throw Error("Packed modal resources leaked");
  return {
    nestedBack: closed,
    cleanup: true,
    siblingPresentations: await qualifySiblingPresentations(),
    scope: "Synthetic host Back transport; native remote behavior pending",
  };
}

async function qualifySiblingPresentations() {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput();
  const root = createNativeRoot(scene, {
    input,
    strictMode: true,
    viewport: { width: 1920, height: 1080 },
    text: { prepare() {}, metrics: () => ({ lineHeight: 20, width: () => 8 }) },
  });
  const target = globalThis as unknown as { __RNR_MODAL_ORDER__?: ModalOrderFixtureAPI };
  const settle = async () => {
    for (let index = 0; index < 5; index++) {
      await root.whenCommitted();
      root.flush();
    }
  };
  let closed: string[] = [];
  try {
    root.render(createElement(ModalOrderFixture));
    await settle();
    root.runSync(() => target.__RNR_MODAL_ORDER__!.open("b"));
    await settle();
    for (let turn = 0; turn < 2; turn++) {
      root.runSync(() => target.__RNR_MODAL_ORDER__!.open("a"));
      await settle();
      input.dispatch({ key: "back", phase: "down" });
      input.dispatch({ key: "back", phase: "up" });
      await settle();
      const state = target.__RNR_MODAL_ORDER__!.snapshot();
      if (
        state.a ||
        !state.b ||
        state.closed.join(",") !==
          Array(turn + 1)
            .fill("a")
            .join(",")
      )
        throw Error("Packed sibling Modal used mount order instead of presentation order");
    }
    input.dispatch({ key: "back", phase: "down" });
    input.dispatch({ key: "back", phase: "up" });
    await settle();
    closed = target.__RNR_MODAL_ORDER__!.snapshot().closed;
    if (closed.join(",") !== "a,a,b" || input.observerCount !== 0)
      throw Error("Packed sibling Modal retained an obsolete Back owner");
  } finally {
    root.unmount();
    input.dispose();
  }
  if (scene.nodes.size !== 1 || scene.listenerCount !== 0 || target.__RNR_MODAL_ORDER__)
    throw Error("Packed sibling Modal resources leaked");
  return { closed, cleanup: true };
}
