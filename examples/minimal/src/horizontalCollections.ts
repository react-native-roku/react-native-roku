import { createElement, createRef, type ElementRef } from "react";
import { createNativeRoot, NativeInput } from "react-native-roku";
import { FlatList, Pressable, View, type NativeViewHandle } from "react-native";
import { RecordingSceneGraph } from "react-native-roku/testing";

/** Independent public-import checks; recording counts do not measure native performance. */
export async function qualifyHorizontalCollections() {
  const outcomes = [];
  for (const declared of [true, false]) {
    const scene = new RecordingSceneGraph(),
      input = new NativeInput(),
      ref = createRef<ElementRef<typeof FlatList<{ id: string; width: number }>>>(),
      handles = new Map<string, NativeViewHandle>();
    let data = Array.from({ length: 30001 }, (_, index) => ({
      id: String(index),
      width: [20, 30, 40][index % 3],
    }));
    const root = createNativeRoot(scene, {
      input,
      strictMode: true,
      viewport: { width: 100, height: 40 },
      text: {
        prepare() {},
        metrics: () => ({ lineHeight: 20, width: (value: string) => value.length * 8 }),
      },
    });
    const settle = async () => {
      for (let index = 0; index < 8; index++) {
        await root.whenCommitted();
        root.flush();
      }
    };
    const demand = (condition: unknown, message: string) => {
      if (!condition) throw Error("Packed horizontal: " + message);
    };
    const position = (id: string) => {
      let rect: { x: number; y: number; width: number; height: number } | undefined;
      handles.get(id)?.measureInWindow((x, y, width, height) => {
        rect = { x, y, width, height };
      });
      return rect;
    };
    let renderCalls = 0,
      maximumMounted = 0,
      activations = 0;
    const renderItem = ({ item }: { item: { id: string; width: number } }) => {
      renderCalls++;
      return createElement(Pressable, {
        nativeID: "horizontal-packed-" + item.id,
        ref: (handle) => {
          if (handle) handles.set(item.id, handle);
          else handles.delete(item.id);
        },
        style: { width: item.width, height: 20 },
        onPress: () => activations++,
      });
    };
    const render = (extraData = 0) => {
      let cursor = 0;
      const frames = data.map((item, index) => {
        const frame = { index, length: item.width, offset: cursor };
        cursor += item.width;
        return frame;
      });
      root.render(
        createElement(FlatList<(typeof data)[number]>, {
          ref,
          data,
          horizontal: true,
          renderItem,
          keyExtractor: (item) => item.id,
          getItemLayout: declared ? (_data, index) => frames[index] : undefined,
          initialScrollIndex: declared ? 15000 : 0,
          maintainVisibleContentPosition: { minIndexForVisible: 0 },
          extraData,
          initialNumToRender: 2,
          maxToRenderPerBatch: 1,
          updateCellsBatchingPeriod: 60000,
          windowSize: 3,
          showsHorizontalScrollIndicator: false,
          showsVerticalScrollIndicator: false,
          ListHeaderComponent: createElement(View, { style: { width: 15, height: 20 } }),
          ListFooterComponent: createElement(View, {
            nativeID: "horizontal-footer",
            style: { width: 17, height: 20 },
            ref: (handle) => {
              if (handle) handles.set("footer", handle);
              else handles.delete("footer");
            },
          }),
          contentContainerStyle: { paddingLeft: 5, paddingRight: 7 },
          style: { width: 100, height: 40, flexGrow: 0, flexShrink: 0 },
        }),
      );
    };
    const checkWindow = () => {
      maximumMounted = Math.max(maximumMounted, handles.size - 1);
      demand(handles.size < 32, "the retained window must stay bounded");
    };
    try {
      render();
      await settle();
      checkWindow();
      demand(renderCalls < 100, "initial rendering must not traverse the entire dataset");
      if (declared) {
        demand(position("15000")?.x === 0, "initial index must use horizontal declared geometry");
        const owner = [...scene.nodes.values()].find(
          (node) => node.fields.id === "horizontal-packed-15000",
        )!;
        scene.emit(owner, "focusedChild", "horizontal-packed-15000");
        input.dispatch({ key: "select", phase: "down" });
        data = [{ id: "prepend", width: 55 }, ...data];
        render(1);
        await settle();
        demand(
          position("15000")?.x === 0 && scene.nodes.get(owner.id) === owner,
          "insertion must preserve the visible keyed owner",
        );
        const pivot = data.findIndex((item) => item.id === "15000");
        data = [...data.slice(pivot), ...data.slice(0, pivot)];
        render(2);
        await settle();
        demand(
          position("15000")?.x === 0 && scene.nodes.get(owner.id) === owner,
          "anchor correction must precede window retirement",
        );
        input.dispatch({ key: "select", phase: "up" });
        demand(activations === 1, "held input must finish on its retained owner once");
        ref.current!.scrollToIndex({ index: 1, viewPosition: 0.5, animated: false });
        await settle();
        demand(position("15001")?.x === 35, "index alignment must use item width");
      }
      ref.current!.scrollToEnd({ animated: false });
      await settle();
      checkWindow();
      demand(handles.has(data.at(-1)!.id), "End must retain the variable-width tail");
      const footer = position("footer")!;
      demand(footer.x + footer.width === 93, "End must include footer and trailing inset");
      ref.current!.scrollToOffset({ offset: 0, animated: false });
      await settle();
      checkWindow();
      demand(position(data[0].id)?.x === 20, "offset zero must retain header and leading inset");
      data = data.slice(0, 2);
      render(3);
      await settle();
      demand(handles.size === 3, "shrinking data must retire obsolete cells");
    } finally {
      root.unmount();
      input.dispose();
    }
    const operations = scene.operations.length;
    await new Promise((accept) => setTimeout(accept, 10));
    demand(
      scene.nodes.size === 1 &&
        scene.listenerCount === 0 &&
        input.targetCount === 0 &&
        handles.size === 0 &&
        scene.operations.length === operations,
      "unmount must retire refs, listeners, native resources and queued work",
    );
    outcomes.push({
      declaredGeometry: declared,
      dataLength: 30001,
      maximumMounted,
      renderCalls,
      createOperations: scene.operations.filter((operation) => operation.operation === "create")
        .length,
      scope: "Recording host work and geometry; no native scroll/focus/performance qualification",
    });
  }
  return outcomes;
}
