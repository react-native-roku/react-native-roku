import { createElement, createRef } from "react";
import { expect, it } from "vitest";
import { FlatList, type FlatListHandle, type FlatListProps } from "./flatList";
import { createNativeRoot } from "./createNativeRoot";
import { NativeInput } from "./NativeInput";
import { Pressable, View } from "./primitives";
import type { NativeViewHandle } from "./nativeViewHandle";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";

const settle = async (root: ReturnType<typeof createNativeRoot>) => {
  for (let i = 0; i < 6; i++) {
    await root.whenCommitted();
    root.flush();
  }
};
for (const [horizontal, columns] of [
  [false, 1],
  [false, 2],
  [false, 3],
  [true, 1],
] as const) {
  it(`measures styled header/footer wrappers for ${horizontal ? "horizontal" : "vertical"} ${columns} columns`, async () => {
    const scene = new RecordingSceneGraph(),
      input = new NativeInput(),
      list = createRef<FlatListHandle>();
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
      const props = {
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
        ListHeaderComponent: present ? createElement(View, { ref: header, style: size(10) }) : null,
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
        ListFooterComponent: present ? createElement(View, { ref: footer, style: size(8) }) : null,
        ListFooterComponentStyle: [size(foot), horizontal ? { paddingLeft: 4 } : { paddingTop: 4 }],
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
      root.render(createElement(FlatList<{ id: number }>, props as FlatListProps<{ id: number }>));
      await settle(root);
    };
    try {
      await render(32, 24);
      expect(measure(header.current)).toBe(6);
      expect(measure(handles.get(0))).toBe(32);
      list.current!.scrollToIndex({ index: 5, animated: false });
      await settle(root);
      expect(offset).toBe(132);
      expect(measure(handles.get(5 * columns))).toBe(0);
      list.current!.scrollToEnd({ animated: false });
      await settle(root);
      expect(offset).toBe(32 + Math.ceil(data.length / columns) * 20 + 24 - 60);
      expect(measure(footer.current)).toBe(40);
      await render(44, 36);
      list.current!.scrollToEnd({ animated: false });
      await settle(root);
      expect(offset).toBe(44 + Math.ceil(data.length / columns) * 20 + 36 - 60);
      expect(measure(footer.current)).toBe(28);
      await render(44, 36, false);
      list.current!.scrollToOffset({ offset: 0, animated: false });
      await settle(root);
      expect(measure(handles.get(0))).toBe(0);
      expect(header.current).toBeNull();
      expect(footer.current).toBeNull();
      await render(44, 36, true, 3, 1);
      expect(offset).toBe(104);
      expect(measure(handles.get(3 * columns))).toBe(0);
      await render(32, 24, true, 0, 2, true);
      list.current!.scrollToIndex({ index: 2, animated: false });
      await settle(root);
      expect(offset).toBe(84);
      expect(measure(handles.get(2 * columns))).toBe(0);
      await render(32, 24, true, 3, 3, true);
      expect(offset).toBe(104);
      expect(measure(handles.get(3 * columns))).toBe(0);
      await render(32, 24, true, 0, 4, "percent");
      const origin = measure(handles.get(0));
      expect(Number.isFinite(origin)).toBe(true);
      list.current!.scrollToIndex({ index: 2, animated: false });
      await settle(root);
      expect(offset).toBe(origin + 40);
      expect(measure(handles.get(2 * columns))).toBe(0);
      expect(handles.size).toBeLessThan(32 * columns);
    } finally {
      root.unmount();
      input.dispose();
    }
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
    expect(input.targetCount).toBe(0);
  });
}
