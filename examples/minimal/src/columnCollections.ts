import { createElement, createRef, type ElementRef } from "react";
import { createNativeRoot, NativeInput } from "react-native-roku";
import { FlatList, Pressable, type NativeViewHandle } from "react-native";
import { RecordingSceneGraph } from "react-native-roku/testing";

/** Bounded original-data geometry and public lifetime checks, separate from SDK/firmware. */
export async function qualifyColumnCollections() {
  const outcomes = [];
  for (const numColumns of [2, 3]) {
    const scene = new RecordingSceneGraph(),
      input = new NativeInput(),
      ref = createRef<ElementRef<typeof FlatList<{ id: string }>>>();
    const handles = new Map<string, NativeViewHandle>();
    const data = Array.from({ length: 30001 }, (_, index) => ({ id: String(index) }));
    const root = createNativeRoot(scene, {
      input,
      strictMode: true,
      viewport: { width: 400, height: 40 },
      text: {
        prepare() {},
        metrics: () => ({ lineHeight: 20, width: (text: string) => text.length * 8 }),
      },
    });
    const settle = async () => {
      for (let i = 0; i < 6; i++) {
        await root.whenCommitted();
        root.flush();
      }
    };
    const demand = (condition: unknown, message: string) => {
      if (!condition) throw Error("Packed columns: " + message);
    };
    let rendered = 0,
      maximumMounted = 0;
    const renderItem = ({ item, index }: { item: { id: string }; index: number }) => {
      rendered++;
      demand(item === data[index], "renderItem must receive the original item index");
      return createElement(Pressable, {
        nativeID: "grid-" + item.id,
        style: { width: 100, height: 20 },
        ref: (handle) => {
          if (handle) handles.set(item.id, handle);
          else handles.delete(item.id);
        },
      });
    };
    const keyExtractor = (item: { id: string }, index: number) => {
      demand(item === data[index], "keyExtractor must receive the original item index");
      return item.id;
    };
    const getItemLayout = (
      original: typeof data | readonly { id: string }[] | null | undefined,
      index: number,
    ) => {
      demand(
        original === data && index < Math.ceil(data.length / numColumns),
        "declared layout uses original data and row indices",
      );
      return { index, length: 20, offset: index * 20 };
    };
    const render = (extraData: number) =>
      root.render(
        createElement(FlatList<{ id: string }>, {
          ref,
          data,
          numColumns,
          renderItem,
          keyExtractor,
          getItemLayout,
          extraData,
          initialNumToRender: 1,
          initialScrollIndex: 30,
          maxToRenderPerBatch: 1,
          updateCellsBatchingPeriod: 60000,
          windowSize: 3,
          columnWrapperStyle: { columnGap: 10 },
          showsVerticalScrollIndicator: false,
          style: { width: 400, height: 40 },
        }),
      );
    const checkWindow = () => {
      maximumMounted = Math.max(maximumMounted, handles.size);
      demand(handles.size < 64, "large data must not mount its complete dataset");
      for (const key of handles.keys()) {
        const start = Math.floor(Number(key) / numColumns) * numColumns;
        for (let index = start; index < Math.min(data.length, start + numColumns); index++)
          demand(handles.has(String(index)), "retained windows must contain complete rows");
      }
    };
    try {
      render(0);
      await settle();
      checkWindow();
      demand(rendered < 100, "initial visible work must remain bounded");
      const positions: number[] = [];
      handles.get(String(30 * numColumns))?.measureInWindow((_x, y) => positions.push(y));
      demand(JSON.stringify(positions) === "[0]", "initialScrollIndex addresses row 30");
      const first = [...scene.nodes.values()].find(
        (node) => node.fields.id === "grid-" + 30 * numColumns,
      )!;
      scene.emit(first, "focusedChild", "grid-" + 30 * numColumns);
      input.dispatch({ key: "select", phase: "down" });
      render(1);
      await settle();
      demand(scene.nodes.get(first.id) === first, "extraData must retain keyed native rows");
      input.dispatch({ key: "select", phase: "up" });
      ref.current!.scrollToEnd({ animated: false });
      await settle();
      checkWindow();
      demand(handles.has("30000"), "end scrolling must retain the incomplete last row");
      ref.current!.scrollToIndex({ index: 0, animated: false });
      await settle();
      checkWindow();
      demand(
        handles.has("0") && !handles.has("30000"),
        "a distant scroll must retire the old window",
      );
    } finally {
      root.unmount();
      input.dispose();
    }
    const retiredOperations = scene.operations.length;
    await new Promise((accept) => setTimeout(accept, 10));
    demand(
      scene.nodes.size === 1 &&
        scene.listenerCount === 0 &&
        input.targetCount === 0 &&
        handles.size === 0 &&
        scene.operations.length === retiredOperations,
      "retirement must clear queued work, refs, input and native resources",
    );
    outcomes.push({
      numColumns,
      dataLength: data.length,
      maximumMounted,
      renderCalls: rendered,
      createOperations: scene.operations.filter((operation) => operation.operation === "create")
        .length,
      scope:
        "Recording host allocation/work counts; no native scroll, focus or memory qualification",
    });
  }
  return outcomes;
}
