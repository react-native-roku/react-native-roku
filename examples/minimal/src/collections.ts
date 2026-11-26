import { createElement, createRef, type ElementRef } from "react";
import { createNativeRoot } from "react-native-roku";
import { FlatList, View, type NativeViewHandle } from "react-native";
import { RecordingSceneGraph } from "react-native-roku/testing";

/** Ordinary public imports from the installed archive; no source-tree helpers. */
export async function qualifyCollections() {
  const scene = new RecordingSceneGraph();
  const root = createNativeRoot(scene, {
    strictMode: true,
    viewport: { width: 400, height: 40 },
    text: {
      prepare() {},
      metrics: () => ({ lineHeight: 20, width: (text: string) => text.length * 8 }),
    },
  });
  const ref = createRef<ElementRef<typeof FlatList<string>>>();
  const target = createRef<NativeViewHandle>();
  const data = Array.from({ length: 1000 }, (_, index) => String(index));
  const rows = () =>
    [...scene.nodes.values()].filter((node) =>
      String(node.fields.id).startsWith("collection-row-"),
    );
  const render = (period: number, key = "batch", initialScrollIndex = 0) =>
    root.render(
      createElement(FlatList<string>, {
        key,
        ref,
        data,
        keyExtractor: (item) => item,
        renderItem: ({ item }) =>
          createElement(View, {
            ref: item === "500" ? target : undefined,
            nativeID: `collection-row-${item}`,
            style: { height: 20 },
          }),
        getItemLayout: (_data, index) => ({ index, offset: index * 20, length: 20 }),
        initialScrollIndex,
        initialNumToRender: 2,
        windowSize: 7,
        maxToRenderPerBatch: 2,
        updateCellsBatchingPeriod: period,
        showsVerticalScrollIndicator: false,
        style: { width: 400, height: 40 },
      }),
    );
  try {
    render(60000);
    await root.whenCommitted();
    if (rows().length !== 2)
      throw Error("Packed collection rendered the offscreen window synchronously");
    const first = rows()[0];
    render(1);
    const deadline = Date.now() + 3000;
    while (rows().length !== 9 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await root.whenCommitted();
    }
    if (rows().length !== 9 || rows()[0] !== first)
      throw Error("Packed collection batching lost its retained row/window");
    render(60000, "initial", 500);
    await root.whenCommitted();
    const positions: number[] = [];
    target.current?.measureInWindow((_x, y) => positions.push(y));
    if (JSON.stringify(positions) !== "[0]")
      throw Error("Packed collection did not apply its initial index");
    ref.current!.scrollToOffset({ offset: 0, animated: false });
    await root.whenCommitted();
    if (!rows().some((node) => node.fields.id === "collection-row-0"))
      throw Error("Packed collection did not prioritize a distant visible destination");
  } finally {
    root.unmount();
  }
  const retired = scene.operations.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  if (scene.nodes.size !== 1 || scene.listenerCount !== 0 || scene.operations.length !== retired)
    throw Error("Packed collection retained deferred work after root retirement");
  return {
    initialWindowBounded: true,
    windowExpanded: true,
    retainedIdentity: true,
    initialIndex: true,
    visibleDestination: true,
    retirement: true,
  };
}
