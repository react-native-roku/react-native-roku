import { createElement, createRef, useState, useId } from "react";
import { describe, expect, it, vi } from "vitest";
import * as layout from "../layout/flexLayout";
import { createNativeRoot } from "./createNativeRoot";
import { ScrollView, type ScrollViewHandle } from "./scrollView";
import { FlatList, type FlatListHandle } from "./flatList";
import { View, Text } from "./primitives";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
const text = {
  prepare() {},
  metrics: () => ({
    lineHeight: 20,
    width: (value: string) => value.length * 7,
  }),
};
const settle = async (root: ReturnType<typeof createNativeRoot>) => {
  for (let index = 0; index < 5; index++) {
    await root.whenCommitted();
    root.flush();
  }
};
describe("native scrolling and keyed windows", () => {
  it("reuses stable geometry and lays out content that shrinks during a scroll update", async () => {
    const scene = new RecordingSceneGraph();
    const root = createNativeRoot(scene, { text, viewport: { width: 800, height: 100 } });
    const scroll = createRef<ScrollViewHandle>();
    const child = createRef<import("./nativeViewHandle").NativeViewHandle>();
    const sizes = vi.fn();
    const events = vi.fn();
    const solve = vi.spyOn(layout, "calculateFlexLayout");
    function Fixture() {
      const [height, setHeight] = useState(400);
      resize = setHeight;
      return createElement(
        ScrollView,
        {
          ref: scroll,
          nativeID: "viewport",
          style: { width: 200, height: 100, paddingTop: 2 },
          showsVerticalScrollIndicator: false,
          onContentSizeChange: sizes,
          onScroll: events,
        },
        createElement(View, { ref: child, style: { width: 200, height } }),
      );
    }
    let resize: (height: number) => void;
    try {
      root.render(createElement(Fixture));
      await settle(root);
      const window = [...scene.nodes.values()].find((node) => node.fields.id === "viewport")!;
      const assertPosition = (offset: number, height: number) => {
        const relative = vi.fn();
        const absolute = vi.fn();
        child.current!.measureInWindow(absolute);
        child.current!.measureLayout(scroll.current!, relative);
        expect(relative).toHaveBeenCalledWith(0, 2 - offset, 200, height);
        expect(absolute).toHaveBeenCalledWith(0, 2 - offset, 200, height);
        expect(window.fields.clippingRect).toEqual([0, 0, 200, 100]);
        expect(events).toHaveBeenLastCalledWith({
          nativeEvent: {
            contentOffset: { x: 0, y: offset },
            contentSize: { width: 200, height },
            layoutMeasurement: { width: 200, height: 100 },
          },
        });
      };
      solve.mockClear();
      scroll.current!.scrollTo({ y: 250, animated: false });
      await settle(root);
      expect(solve).not.toHaveBeenCalled();
      assertPosition(250, 400);

      root.runSync(() => {
        scroll.current!.scrollTo({ y: 275, animated: false });
        resize(180);
      });
      await settle(root);
      expect(solve).toHaveBeenCalledTimes(1);
      expect(sizes.mock.calls).toEqual([
        [200, 400],
        [200, 180],
      ]);
      assertPosition(80, 180);
    } finally {
      solve.mockRestore();
      root.unmount();
    }
  });
  it("preserves relative Yoga offsets when an ancestor aligns the scroll content baseline", async () => {
    const root = createNativeRoot(new RecordingSceneGraph(), {
      text,
      viewport: { width: 800, height: 500 },
    });
    const scroll = createRef<ScrollViewHandle>();
    const child = createRef<import("./nativeViewHandle").NativeViewHandle>();
    try {
      root.render(
        createElement(
          View,
          { style: { width: 800, height: 500, flexDirection: "row", alignItems: "baseline" } },
          createElement(Text, { style: { width: 80 } }, "Sibling"),
          createElement(
            ScrollView,
            {
              ref: scroll,
              style: { width: 300, height: 100 },
              showsVerticalScrollIndicator: false,
            },
            createElement(
              View,
              { ref: child, style: { width: 250, height: 200 } },
              createElement(Text, {}, "Baseline"),
            ),
          ),
        ),
      );
      await settle(root);
      scroll.current!.scrollTo({ y: 30 });
      await settle(root);
      const viewportPosition = vi.fn();
      const childPosition = vi.fn();
      scroll.current!.measureInWindow(viewportPosition);
      child.current!.measureInWindow(childPosition);
      expect(viewportPosition).toHaveBeenCalledWith(80, 30, 720, 100);
      expect(childPosition).toHaveBeenCalledWith(80, 0, 250, 200);
    } finally {
      root.unmount();
    }
  });
  it("updates the retained window through extraData with stable data/render functions and keeps native identity", async () => {
    const scene = new RecordingSceneGraph(),
      root = createNativeRoot(scene, { text, viewport: { width: 800, height: 100 } });
    const data = ["first", "second"];
    let selected = "first";
    const renderItem = ({ item }: { item: string }) =>
      createElement(
        View,
        { nativeID: `item-${item}`, style: { height: 20 } },
        createElement(Text, {}, `${item}:${item === selected}`),
      );
    const render = (clipped: boolean) =>
      root.render(
        createElement(FlatList<string>, {
          data,
          extraData: selected,
          renderItem,
          removeClippedSubviews: clipped,
          style: { width: 400, height: 100 },
        }),
      );
    try {
      render(false);
      await settle(root);
      const before = [...scene.nodes.values()].find((node) => node.fields.id === "item-first");
      selected = "second";
      render(true);
      await settle(root);
      const labels = [...scene.nodes.values()]
        .filter((node) => node.type === "label")
        .map((node) => node.fields.text);
      expect(labels).toContain("first:false");
      expect(labels).toContain("second:true");
      expect([...scene.nodes.values()].find((node) => node.fields.id === "item-first")).toBe(
        before,
      );
    } finally {
      root.unmount();
    }
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
  });
  it.each([true, false])(
    "includes separators across window changes and omits the trailing separator (declared=%s)",
    async (declared) => {
      const scene = new RecordingSceneGraph(),
        root = createNativeRoot(scene, { text, viewport: { width: 800, height: 60 } }),
        list = createRef<FlatListHandle>();
      const data = Array.from({ length: 1000 }, (_, index) => String(index));
      const Separator = () =>
        createElement(View, { nativeID: `separator-${useId()}`, style: { height: 5 } });
      try {
        root.render(
          createElement(FlatList<string>, {
            ref: list,
            data,
            renderItem: ({ item }) =>
              createElement(
                View,
                { nativeID: `row-${item}`, style: { height: 20 } },
                createElement(Text, {}, item),
              ),
            ItemSeparatorComponent: Separator,
            getItemLayout: declared
              ? (_data, index) => ({ length: 20, offset: 25 * index, index })
              : undefined,
            style: { width: 400, height: 60 },
            windowSize: 3,
            initialNumToRender: 4,
          }),
        );
        await settle(root);
        const atStart = scene.nodes.size;
        if (declared) list.current!.scrollToIndex({ index: 999, animated: false });
        else list.current!.scrollToEnd({ animated: false });
        await settle(root);
        const rows = [...scene.nodes.values()].filter((node) =>
          String(node.fields.id).startsWith("row-"),
        );
        const separators = [...scene.nodes.values()].filter((node) =>
          String(node.fields.id).startsWith("separator-"),
        );
        expect(
          rows.some((node) => node.fields.id === "row-999"),
          JSON.stringify(
            rows.map((node) => ({
              id: node.fields.id,
              translation: node.fields.translation,
              height: node.fields.height,
            })),
          ),
        ).toBe(true);
        expect(scene.nodes.size).toBeLessThan(atStart + 30);
        expect(separators.length).toBe(rows.length - 1);
        list.current!.scrollToOffset({ offset: 0, animated: false });
        await settle(root);
        expect([...scene.nodes.values()].some((node) => node.fields.id === "row-0")).toBe(true);
        expect([...scene.nodes.values()].some((node) => node.fields.id === "row-999")).toBe(false);
      } finally {
        root.unmount();
      }
      expect(scene.nodes.size).toBe(1);
      expect(scene.listenerCount).toBe(0);
    },
  );
  it("delivers child layouts after a synchronous parent resize supersedes the first callback batch", async () => {
    const scene = new RecordingSceneGraph(),
      root = createNativeRoot(scene, {
        text,
        viewport: { width: 800, height: 600 },
      }),
      delivered: number[] = [];
    function Resizing() {
      const [width, setWidth] = useState(200);
      return createElement(
        View,
        {
          style: { width, height: 100 },
          onLayout: () => {
            if (width === 200) setWidth(300);
          },
        },
        createElement(View, {
          style: { height: 20 },
          onLayout: (event) =>
            delivered.push(
              (event as { nativeEvent: { layout: { width: number } } }).nativeEvent.layout.width,
            ),
        }),
      );
    }
    root.render(createElement(Resizing));
    await settle(root);
    expect(delivered).toEqual([300]);
    root.unmount();
  });
  it("queues scroll requests until measurements exist, clamps to real content, and measures translated children", async () => {
    const scene = new RecordingSceneGraph(),
      root = createNativeRoot(scene, {
        text,
        viewport: { width: 800, height: 100 },
      });
    const scroll = createRef<ScrollViewHandle>(),
      child = createRef<import("./nativeViewHandle").NativeViewHandle>(),
      events: unknown[] = [];
    root.render(
      createElement(
        ScrollView,
        {
          ref: scroll,
          style: { width: 200, height: 100 },
          showsVerticalScrollIndicator: false,
          showsHorizontalScrollIndicator: false,
          onScroll: (event) => events.push(event.nativeEvent.contentOffset.y),
        },
        createElement(View, { ref: child, style: { width: 200, height: 400 } }),
      ),
    );
    scroll.current!.scrollTo({ y: 250, animated: false });
    await settle(root);
    const positions: number[] = [];
    child.current!.measureInWindow((_x, y) => positions.push(y));
    expect(positions).toEqual([-250]);
    scroll.current!.scrollTo({ y: 999, animated: false });
    await settle(root);
    child.current!.measureInWindow((_x, y) => positions.push(y));
    expect(positions).toEqual([-250, -300]);
    expect(events).toContain(300);
    root.unmount();
    expect(scene.nodes.size).toBe(1);
  });
  it("keeps a thousand-item collection bounded, scrolls to its last item, and preserves stable visible keys", async () => {
    const scene = new RecordingSceneGraph(),
      root = createNativeRoot(scene, {
        text,
        viewport: { width: 800, height: 100 },
      });
    const list = createRef<FlatListHandle>();
    const items = Array.from({ length: 1000 }, (_, index) => ({
      id: String(index),
    }));
    const render = (data = items) =>
      root.render(
        createElement(FlatList<{ id: string }>, {
          ref: list,
          data,
          keyExtractor: (item) => item.id,
          renderItem: ({ item }) =>
            createElement(
              View,
              { nativeID: `row-${item.id}`, style: { height: 20 } },
              createElement(Text, {}, item.id),
            ),
          getItemLayout: (_data, index) => ({
            index,
            length: 20,
            offset: index * 20,
          }),
          style: { width: 400, height: 100 },
          windowSize: 3,
          initialNumToRender: 6,
          showsVerticalScrollIndicator: false,
        }),
      );
    render();
    await settle(root);
    expect(
      [...scene.nodes.values()].filter((node) => node.fields.id?.toString().startsWith("row-"))
        .length,
    ).toBeLessThan(30);
    list.current!.scrollToIndex({ index: 999, animated: false });
    await settle(root);
    expect([...scene.nodes.values()].some((node) => node.fields.id === "row-999")).toBe(true);
    expect(scene.nodes.size).toBeLessThan(100);
    const last = [...scene.nodes.values()].find((node) => node.fields.id === "row-999")!;
    render([...items, { id: "1000" }]);
    await settle(root);
    expect(scene.nodes.get(last.id)).toBe(last);
    list.current!.scrollToOffset({ offset: 9_999_999, animated: false });
    await settle(root);
    expect(scene.nodes.size).toBeLessThan(100);
    root.unmount();
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
  });
  it("retains a visible item's window position when the declared policy preserves prepended data", async () => {
    const scene = new RecordingSceneGraph(),
      root = createNativeRoot(scene, {
        text,
        viewport: { width: 800, height: 100 },
      }),
      list = createRef<FlatListHandle>();
    const original = Array.from({ length: 100 }, (_, index) => String(index));
    const render = (data: string[]) =>
      root.render(
        createElement(FlatList<string>, {
          ref: list,
          data,
          keyExtractor: (item) => item,
          renderItem: ({ item }) =>
            createElement(View, {
              nativeID: `item-${item}`,
              style: { height: 20 },
            }),
          getItemLayout: (_data, index) => ({ length: 20, offset: index * 20 }),
          style: { width: 200, height: 100 },
          maintainVisibleContentPosition: { minIndexForVisible: 0 },
          showsVerticalScrollIndicator: false,
        }),
      );
    render(original);
    await settle(root);
    list.current!.scrollToIndex({ index: 50, animated: false });
    await settle(root);
    const before = [...scene.nodes.values()].find((node) => node.fields.id === "item-50")!;
    const globalY = (id: number): number => {
      const node = scene.nodes.get(id)!;
      return (
        Number((node.fields.translation as number[] | undefined)?.[1] ?? 0) +
        (node.parent && node.parent.id ? globalY(node.parent.id) : 0)
      );
    };
    const position = globalY(before.id);
    render(["new-a", "new-b", ...original]);
    await settle(root);
    expect(scene.nodes.get(before.id)).toBe(before);
    expect(globalY(before.id)).toBe(position);
    root.unmount();
  });
});
