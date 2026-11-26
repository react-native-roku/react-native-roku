import { createElement, createRef } from "react";
import { FlatList, Pressable, View, type NativeViewHandle } from "react-native";
import type { ComponentProps, ElementRef } from "react";
import { createNativeRoot } from "react-native-roku";
import { NativeInput } from "react-native-roku";
import { RecordingSceneGraph } from "react-native-roku/testing";

const settle = async (root: ReturnType<typeof createNativeRoot>) => {
  for (let i = 0; i < 6; i++) {
    await root.whenCommitted();
    root.flush();
  }
};
export async function qualifyCollectionBoundaryStyles() {
  const results = [];
  const demand = (condition: unknown, message: string) => {
    if (!condition) throw Error("Packed boundary styles: " + message);
  };
  for (const [horizontal, columns] of [
    [false, 1],
    [false, 2],
    [false, 3],
    [true, 1],
  ] as const) {
    {
      const scene = new RecordingSceneGraph(),
        input = new NativeInput(),
        list = createRef<ElementRef<typeof FlatList<{ id: number }>>>();
      const header = createRef<NativeViewHandle>(),
        footer = createRef<NativeViewHandle>(),
        handles = new Map<number, NativeViewHandle>();
      const root = createNativeRoot(scene, {
        input,
        viewport: { width: 400, height: 200 },
        text: { prepare() {}, metrics: () => ({ lineHeight: 20, width: () => 8 }) },
      });
      const data = Array.from({ length: 101 }, (_, id) => ({ id }));
      const size = (length: number) =>
        horizontal ? { width: length, height: 20 } : { height: length, width: 80 };
      const measure = (handle: NativeViewHandle | null | undefined) => {
        let result = Number.NaN;
        handle?.measureInWindow((x, y) => {
          result = horizontal ? x : y;
        });
        return result;
      };
      let offset = 0;
      const render = async (
        head: number,
        foot: number,
        present = true,
        initialScrollIndex = 0,
        identity = 0,
        outerMargin: boolean | "percent" = false,
      ) => {
        const props: ComponentProps<typeof FlatList<{ id: number }>> = {
          ref: list,
          key: identity,
          initialScrollIndex,
          data,
          horizontal,
          numColumns: columns,
          keyExtractor: (item: { id: number }) => String(item.id),
          style: horizontal
            ? { width: 60, height: 80, flexGrow: 0, flexShrink: 0 }
            : { width: 400, height: 60, flexGrow: 0, flexShrink: 0 },
          ListHeaderComponent: present
            ? createElement(View, { ref: header, style: size(10) })
            : null,
          ListHeaderComponentStyle: [
            size(head),
            horizontal ? { paddingLeft: 6 } : { paddingTop: 6 },
            outerMargin
              ? horizontal
                ? {
                    marginLeft: outerMargin === "percent" ? "5%" : 5,
                    marginRight: outerMargin === "percent" ? "10%" : 7,
                  }
                : {
                    marginTop: outerMargin === "percent" ? "5%" : 5,
                    marginBottom: outerMargin === "percent" ? "10%" : 7,
                  }
              : undefined,
          ],
          ListFooterComponent: present
            ? createElement(View, { ref: footer, style: size(8) })
            : null,
          ListFooterComponentStyle: [
            size(foot),
            horizontal ? { paddingLeft: 4 } : { paddingTop: 4 },
          ],
          getItemLayout: (_data: unknown, index: number) => ({
            index,
            length: 20,
            offset: index * 20,
          }),
          initialNumToRender: 1,
          maxToRenderPerBatch: 1,
          windowSize: 3,
          updateCellsBatchingPeriod: 60000,
          onScroll: (event: { nativeEvent: { contentOffset: { x: number; y: number } } }) => {
            offset = event.nativeEvent.contentOffset[horizontal ? "x" : "y"];
          },
          renderItem: ({ item }: { item: { id: number } }) =>
            createElement(Pressable, {
              style: size(20),
              ref: (handle: NativeViewHandle | null) => {
                if (handle) handles.set(item.id, handle);
                else handles.delete(item.id);
              },
            }),
        };
        root.render(createElement(FlatList<{ id: number }>, props));
        await settle(root);
      };
      try {
        await render(32, 24);
        demand(
          measure(header.current) === 6 && measure(handles.get(0)) === 32,
          "wrapper padding and extent",
        );
        list.current!.scrollToIndex({ index: 5, animated: false });
        await settle(root);
        demand(offset === 132, "index scroll includes wrapper extent");
        demand(measure(handles.get(5 * columns)) === 0, "complete destination row");
        list.current!.scrollToEnd({ animated: false });
        await settle(root);
        demand(
          offset === 32 + Math.ceil(data.length / columns) * 20 + 24 - 60,
          "End includes footer wrapper",
        );
        demand(measure(footer.current) === 40, "footer child keeps its own geometry");
        await render(44, 36);
        list.current!.scrollToEnd({ animated: false });
        await settle(root);
        demand(
          offset === 44 + Math.ceil(data.length / columns) * 20 + 36 - 60,
          "style replacement changes End extent",
        );
        demand(measure(footer.current) === 28, "replaced footer padding");
        await render(44, 36, false);
        list.current!.scrollToOffset({ offset: 0, animated: false });
        await settle(root);
        demand(
          measure(handles.get(0)) === 0 && header.current === null && footer.current === null,
          "missing boundaries ignore wrapper styles",
        );
        await render(44, 36, true, 3, 1);
        demand(
          offset === 104 && measure(handles.get(3 * columns)) === 0,
          "initial index waits for styled header extent",
        );
        await render(32, 24, true, 0, 2, true);
        list.current!.scrollToIndex({ index: 2, animated: false });
        await settle(root);
        demand(
          offset === 84 && measure(handles.get(2 * columns)) === 0,
          "outer header margins participate in index alignment",
        );
        await render(32, 24, true, 3, 3, true);
        demand(
          offset === 104 && measure(handles.get(3 * columns)) === 0,
          "initial index waits for outer header margins",
        );
        await render(32, 24, true, 0, 4, "percent");
        const origin = measure(handles.get(0));
        demand(Number.isFinite(origin), "percentage margins require an actual measured row");
        list.current!.scrollToIndex({ index: 2, animated: false });
        await settle(root);
        demand(
          offset === origin + 40 && measure(handles.get(2 * columns)) === 0,
          "percentage margins preserve declared index alignment",
        );
        demand(handles.size < 32 * columns, "bounded mounted window");
        results.push({
          horizontal,
          columns,
          styledExtent: true,
          replacement: true,
          retirement: true,
        });
      } finally {
        root.unmount();
        input.dispose();
      }
      demand(
        scene.nodes.size === 1 && scene.listenerCount === 0 && input.targetCount === 0,
        "full owner cleanup",
      );
    }
  }
  return {
    results,
    scope: "Committed host wrapper geometry, not native scroll or focus qualification",
  };
}
