import { createElement, createRef, Fragment } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createNativeRoot } from "./createNativeRoot";
import { FlatList, type FlatListHandle, type FlatListProps } from "./flatList";
import { View, Text, Pressable } from "./primitives";
import { useNativeHost, type NativeHostContextValue } from "./nativeHostContext";
import { NativeInput } from "./NativeInput";
import { InteractionManager } from "./interactionManager";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";

type Item = { id: string; width: number };
const settle = async (root: ReturnType<typeof createNativeRoot>) => {
  for (let index = 0; index < 8; index++) {
    await root.whenCommitted();
    root.flush();
  }
};
function fixture(count = 1001) {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput(),
    ref = createRef<FlatListHandle>();
  const data = Array.from({ length: count }, (_, index) => ({
    id: String(index),
    width: [20, 30, 40][index % 3],
  }));
  const presses: string[] = [],
    rendered: number[] = [],
    events: { x: number; y: number }[] = [];
  let host!: NativeHostContextValue;
  function Probe() {
    host = useNativeHost();
    return null;
  }
  const root = createNativeRoot(scene, {
    input,
    strictMode: true,
    viewport: { width: 400, height: 100 },
    text: {
      prepare() {},
      metrics: () => ({ lineHeight: 20, width: (value: string) => value.length * 8 }),
    },
  });
  const renderItem = ({ item, index }: { item: Item; index: number }) => {
    rendered.push(index);
    return createElement(
      Pressable,
      {
        nativeID: "horizontal-" + item.id,
        style: { width: item.width, height: 20 },
        onPress: () => presses.push(item.id),
      },
      createElement(Text, {}, item.id),
    );
  };
  const layout: NonNullable<FlatListProps<Item>["getItemLayout"]> = (items, index) => ({
    index,
    length: items![index].width,
    offset: items!.slice(0, index).reduce((total, item) => total + item.width, 0),
  });
  const render = async (props: Partial<FlatListProps<Item>> = {}, key = "list") => {
    root.render(
      createElement(
        Fragment,
        {},
        createElement(Probe),
        createElement(FlatList<Item>, {
          key,
          ref,
          data,
          horizontal: true,
          renderItem,
          keyExtractor: (item) => item.id,
          initialNumToRender: 2,
          windowSize: 3,
          maxToRenderPerBatch: 1,
          updateCellsBatchingPeriod: 60000,
          showsHorizontalScrollIndicator: false,
          showsVerticalScrollIndicator: false,
          style: { width: 100, height: 40, flexGrow: 0, flexShrink: 0 },
          onScroll: (event) => events.push(event.nativeEvent.contentOffset),
          ...props,
        }),
      ),
    );
    await settle(root);
  };
  const items = () =>
    [...scene.nodes.values()].filter((node) => String(node.fields.id).startsWith("horizontal-"));
  const rect = (id: string) => host.placement(id)?.global;
  const dispose = () => {
    root.unmount();
    input.dispose();
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
  };
  return {
    scene,
    input,
    ref,
    data,
    presses,
    rendered,
    events,
    root,
    layout,
    render,
    items,
    rect,
    dispose,
  };
}
afterEach(() => vi.useRealTimers());

it("lays out variable-width horizontal items along the committed x axis", async () => {
  const f = fixture(10001);
  try {
    await f.render();
    for (const [index, x] of [0, 20, 50, 90].entries())
      expect(f.rect("horizontal-" + index)).toMatchObject({ x, y: 0, height: 20 });
    expect(f.items().length).toBeLessThan(12);
    expect(f.rendered.length).toBeLessThan(100);
    f.ref.current!.scrollToOffset({ offset: 30, animated: false });
    await settle(f.root);
    expect(f.rect("horizontal-2")?.x).toBe(20);
    expect(f.events.at(-1)).toEqual({ x: 30, y: 0 });
  } finally {
    f.dispose();
  }
});

it("applies declared initial/index/end geometry with horizontal header, footer and insets", async () => {
  const f = fixture(101),
    props = {
      getItemLayout: f.layout,
      initialScrollIndex: 50,
      ListHeaderComponent: createElement(View, {
        nativeID: "header",
        style: { width: 25, height: 20 },
      }),
      ListFooterComponent: createElement(View, {
        nativeID: "footer",
        style: { width: 17, height: 20 },
      }),
      contentContainerStyle: { paddingLeft: 5, paddingRight: 7 },
    };
  try {
    await f.render(props);
    expect(f.rect("horizontal-50")?.x).toBe(0);
    f.ref.current!.scrollToIndex({ index: 50, viewPosition: 0.5, animated: false });
    await settle(f.root);
    expect(f.rect("horizontal-50")?.x).toBe(30);
    f.ref.current!.scrollToEnd({ animated: false });
    await settle(f.root);
    expect(f.rect("footer")!.x + f.rect("footer")!.width).toBe(93);
    expect(f.rect("horizontal-100")?.x).toBe(46);
    expect(f.items().length).toBeLessThan(16);
    await f.render({ ...props, style: { width: 180, height: 40, flexGrow: 0, flexShrink: 0 } });
    expect(f.rect("footer")!.x + f.rect("footer")!.width).toBe(173);
    await f.render({
      ...props,
      data: f.data.slice(0, 2),
      style: { width: 180, height: 40, flexGrow: 0, flexShrink: 0 },
    });
    expect(f.rect("horizontal-0")?.x).toBe(30);
    expect(f.events.at(-1)?.x).toBe(0);
  } finally {
    f.dispose();
  }
});

it("measures variable-width tails, reports unknown index geometry and retires old windows", async () => {
  const f = fixture(1001),
    failures: unknown[] = [],
    props = {
      onScrollToIndexFailed: (value: unknown) => failures.push(value),
      ListFooterComponent: createElement(View, {
        nativeID: "footer",
        style: { width: 17, height: 20 },
      }),
      contentContainerStyle: { paddingRight: 7 },
    };
  try {
    await f.render(props);
    f.ref.current!.scrollToIndex({ index: 500, animated: false });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ index: 500 });
    f.ref.current!.scrollToEnd({ animated: false });
    await settle(f.root);
    expect(f.rect("horizontal-1000")).toBeDefined();
    expect(f.rect("footer")!.x + f.rect("footer")!.width).toBe(93);
    f.ref.current!.scrollToOffset({ offset: 0, animated: false });
    await settle(f.root);
    expect(f.rect("horizontal-0")?.x).toBe(0);
    expect(f.rect("horizontal-1000")).toBeUndefined();
  } finally {
    f.dispose();
  }
});

it("retains extraData, row separators and empty boundaries on the horizontal axis", async () => {
  const f = fixture(3);
  let caption = "before";
  const renderItem = ({ item }: { item: Item }) =>
    createElement(
      View,
      { nativeID: "horizontal-" + item.id, style: { width: item.width, height: 20 } },
      createElement(Text, {}, caption),
    );
  const props = {
    renderItem,
    ItemSeparatorComponent: () => createElement(View, { style: { width: 4, height: 20 } }),
    ListHeaderComponent: createElement(View, {
      nativeID: "header",
      style: { width: 10, height: 20 },
    }),
    ListFooterComponent: createElement(View, {
      nativeID: "footer",
      style: { width: 12, height: 20 },
    }),
    ListEmptyComponent: createElement(View, {
      nativeID: "empty",
      style: { width: 20, height: 20 },
    }),
  };
  try {
    await f.render({ ...props, extraData: caption });
    const first = f.items()[0];
    expect(f.rect("horizontal-1")?.x).toBe(34);
    caption = "after";
    await f.render({ ...props, extraData: caption });
    expect(f.items()[0]).toBe(first);
    expect(
      [...f.scene.nodes.values()].filter(
        (node) => String(node.fields.text ?? "").replace(/\n/g, "") === "after",
      ),
    ).toHaveLength(3);
    await f.render({ ...props, data: [] });
    expect(f.items()).toHaveLength(0);
    expect(f.rect("empty")?.x).toBe(10);
    expect(f.rect("footer")?.x).toBe(30);
  } finally {
    f.dispose();
  }
});

it("batches horizontal work behind interaction leases and preserves a held current item", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = fixture(10001);
  try {
    await f.render({ getItemLayout: f.layout, updateCellsBatchingPeriod: 50 });
    const count = f.items().length,
      first = f.items()[0];
    f.scene.emit(first, "focusedChild", "horizontal-0");
    f.input.dispatch({ key: "select", phase: "down" });
    const lease = InteractionManager.createInteractionHandle();
    await vi.advanceTimersByTimeAsync(51);
    await settle(f.root);
    expect(f.items()).toHaveLength(count);
    InteractionManager.clearInteractionHandle(lease);
    await vi.advanceTimersByTimeAsync(1);
    await settle(f.root);
    expect(f.items()).toHaveLength(count + 1);
    expect(f.items()[0]).toBe(first);
    f.input.dispatch({ key: "select", phase: "up" });
    expect(f.presses).toEqual(["0"]);
    await f.render({
      data: f.data.slice(0, 2),
      getItemLayout: f.layout,
      updateCellsBatchingPeriod: 50,
    });
    expect(f.items()).toHaveLength(2);
  } finally {
    f.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves a keyed horizontal anchor across insertion, reorder and resized content", async () => {
  const f = fixture(101),
    props = { getItemLayout: f.layout, maintainVisibleContentPosition: { minIndexForVisible: 0 } };
  try {
    await f.render(props);
    f.ref.current!.scrollToIndex({ index: 50, animated: false });
    await settle(f.root);
    const original = f.items().find((node) => node.fields.id === "horizontal-50")!;
    await f.render({ ...props, data: [{ id: "prepended", width: 55 }, ...f.data] });
    expect(f.rect("horizontal-50")?.x).toBe(0);
    expect(f.items().find((node) => node.fields.id === "horizontal-50")).toBe(original);
    await f.render({ ...props, data: [...f.data.slice(49), ...f.data.slice(0, 49)] });
    expect(f.rect("horizontal-50")?.x).toBe(0);
    expect(f.items().find((node) => node.fields.id === "horizontal-50")).toBe(original);
    await f.render({
      ...props,
      data: f.data.slice(49, 53).map((item) => ({ ...item, width: item.width + 5 })),
    });
    expect(f.items().length).toBeLessThanOrEqual(4);
    expect(f.rect("horizontal-50")?.width).toBe(45);
  } finally {
    f.dispose();
  }
});

it("requires a new list key when switching axes and still rejects horizontal grids", async () => {
  const f = fixture(3);
  try {
    await f.render();
    await expect(f.render({ horizontal: false })).rejects.toThrow("C05_LIST_AXIS_CHANGE");
  } finally {
    f.dispose();
  }
  const grid = fixture(3);
  try {
    await expect(grid.render({ numColumns: 2 })).rejects.toThrow("C05_LIST_AXIS");
  } finally {
    grid.dispose();
  }
});
