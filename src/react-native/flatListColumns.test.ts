import { createElement, createRef, Fragment, useLayoutEffect, useId } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeRoot } from "./createNativeRoot";
import { FlatList, type FlatListHandle, type FlatListProps } from "./flatList";
import { View, Pressable, Text } from "./primitives";
import { useNativeHost, type NativeHostContextValue } from "./nativeHostContext";
import { NativeInput } from "./NativeInput";
import { InteractionManager } from "./interactionManager";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";

type Item = { id: string; title?: string };
const settle = async (root: ReturnType<typeof createNativeRoot>) => {
  for (let i = 0; i < 6; i++) {
    await root.whenCommitted();
    root.flush();
  }
};
function fixture(count = 8, height = 60) {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput(),
    ref = createRef<FlatListHandle>();
  const data = Array.from({ length: count }, (_, index) => ({ id: String(index) }));
  const rendered: { item: Item; index: number }[] = [],
    keys: { item: Item; index: number }[] = [];
  let host!: NativeHostContextValue;
  function Probe() {
    host = useNativeHost();
    return null;
  }
  const root = createNativeRoot(scene, {
    input,
    strictMode: true,
    viewport: { width: 240, height },
    text: {
      prepare() {},
      metrics: () => ({ lineHeight: 20, width: (value: string) => value.length * 8 }),
    },
  });
  const renderItem = ({ item, index }: { item: Item; index: number }) => {
    rendered.push({ item, index });
    return createElement(
      Pressable,
      { nativeID: `item-${item.id}`, style: { width: 60, height: 20 } },
      createElement(Text, {}, item.title ?? item.id),
    );
  };
  const keyExtractor = (item: Item, index: number) => {
    keys.push({ item, index });
    return item.id;
  };
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
          renderItem,
          keyExtractor,
          initialNumToRender: 2,
          maxToRenderPerBatch: 2,
          updateCellsBatchingPeriod: 60000,
          windowSize: 3,
          showsVerticalScrollIndicator: false,
          style: { width: 240, height },
          ...props,
        }),
      ),
    );
    await settle(root);
  };
  const items = () =>
    [...scene.nodes.values()].filter((node) => String(node.fields.id).startsWith("item-"));
  const rect = (id: string) => host.placement(id)?.global;
  const dispose = () => {
    root.unmount();
    input.dispose();
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
    expect(input.targetCount).toBe(0);
  };
  return { scene, input, ref, data, rendered, keys, root, render, items, rect, dispose };
}
afterEach(() => vi.useRealTimers());

describe("FlatList fixed-height column rows", () => {
  it.each([1, 2, 3])(
    "lays out complete rows and original item indices with %i columns",
    async (numColumns) => {
      const f = fixture(7, 160);
      try {
        await f.render({
          numColumns,
          ...(numColumns > 1 ? { columnWrapperStyle: { columnGap: 5 } } : {}),
        });
        expect(f.items()).toHaveLength(7);
        for (let index = 0; index < 7; index++) {
          expect(f.rect(`item-${index}`)).toMatchObject({
            x: (index % numColumns) * 65,
            y: Math.floor(index / numColumns) * 20,
          });
          expect(
            f.rendered.some((entry) => entry.index === index && entry.item === f.data[index]),
          ).toBe(true);
          expect(
            f.keys.some((entry) => entry.index === index && entry.item === f.data[index]),
          ).toBe(true);
        }
      } finally {
        f.dispose();
      }
    },
  );

  it.each([false, true])(
    "keeps row spacing, separators, boundaries and extraData in their owning rows (declared=%s)",
    async (declared) => {
      const f = fixture(7, 160);
      let title = "first";
      const renderItem = ({ item }: { item: Item }) =>
        createElement(
          View,
          { nativeID: `item-${item.id}`, style: { width: 60, height: 20 } },
          createElement(Text, {}, title),
        );
      const props: Partial<FlatListProps<Item>> = {
        numColumns: 3,
        renderItem,
        getItemLayout: declared
          ? (_data, index) => ({ length: 23, offset: index * 25 })
          : undefined,
        columnWrapperStyle: { columnGap: 5, marginBottom: 3 },
        contentContainerStyle: { paddingTop: 7 },
        ItemSeparatorComponent: () =>
          createElement(View, { nativeID: "separator-" + useId(), style: { height: 2 } }),
        ListHeaderComponent: createElement(View, { nativeID: "header", style: { height: 10 } }),
        ListFooterComponent: createElement(View, { nativeID: "footer", style: { height: 11 } }),
        ListEmptyComponent: createElement(Text, { nativeID: "empty" }, "Empty"),
      };
      try {
        await f.render({ ...props, extraData: title });
        const first = f.items()[0];
        expect(f.rect("item-0")?.y).toBe(17);
        expect(f.rect("item-3")?.y).toBe(42);
        expect(f.rect("item-6")?.y).toBe(67);
        expect(f.rect("footer")?.y).toBe(90);
        expect(
          [...f.scene.nodes.values()].filter((node) =>
            String(node.fields.id).startsWith("separator-"),
          ),
        ).toHaveLength(2);
        title = "changed";
        await f.render({ ...props, extraData: title });
        expect(f.items()[0]).toBe(first);
        expect(
          [...f.scene.nodes.values()].filter(
            (node) => node.type === "label" && node.fields.text === title,
          ),
        ).toHaveLength(7);
        await f.render({ ...props, data: [] });
        expect(f.items()).toHaveLength(0);
        expect(f.rect("empty")).toBeDefined();
        expect(f.rect("header")).toBeDefined();
        expect(f.rect("footer")).toBeDefined();
      } finally {
        f.dispose();
      }
    },
  );

  it("uses upstream row indices for declared geometry and initial/index/end scrolling", async () => {
    const f = fixture(302, 160),
      layouts: { data: readonly Item[] | null | undefined; index: number }[] = [];
    const getItemLayout: FlatListProps<Item>["getItemLayout"] = (data, index) => {
      layouts.push({ data, index });
      return { index, offset: index * 20, length: 20 };
    };
    try {
      await f.render({
        numColumns: 3,
        initialScrollIndex: 50,
        getItemLayout,
        style: { width: 240, height: 40, flexGrow: 0, flexShrink: 0 },
      });
      expect(f.rect("item-150")?.y).toBe(0);
      expect(layouts.every((row) => row.data === f.data && row.index < 101)).toBe(true);
      f.ref.current!.scrollToIndex({ index: 1, animated: false });
      await settle(f.root);
      expect(f.rect("item-3")?.y).toBe(0);
      f.ref.current!.scrollToEnd({ animated: false });
      await settle(f.root);
      expect(f.rect("item-300")?.y).toBe(20);
      expect(f.rect("item-301")?.y).toBe(20);
      expect(f.rect("item-299")?.y).toBe(0);
      expect(() => f.ref.current!.scrollToIndex({ index: 101, animated: false })).toThrow(
        "outside the current data",
      );
      await f.render({
        numColumns: 3,
        getItemLayout,
        style: { width: 240, height: 60, flexGrow: 0, flexShrink: 0 },
      });
      expect(f.rect("item-300")?.y).toBe(40);
      await f.render({ numColumns: 3, getItemLayout, data: f.data.slice(0, 2) });
      expect(f.rect("item-0")?.y).toBe(0);
      expect(f.items()).toHaveLength(2);
    } finally {
      f.dispose();
    }
  });

  it("bounds large windows in complete rows, batches rows and retires interaction work", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture(30000, 60),
      props = {
        numColumns: 3,
        initialNumToRender: 1,
        maxToRenderPerBatch: 1,
        updateCellsBatchingPeriod: 50,
        getItemLayout: (_data: unknown, index: number) => ({ offset: index * 20, length: 20 }),
      };
    try {
      await f.render(props);
      expect(f.items()).toHaveLength(9);
      expect(f.rendered.length).toBeLessThan(100);
      const first = f.items()[0];
      f.scene.emit(first, "focusedChild", "item-0");
      f.input.dispatch({ key: "select", phase: "down" });
      const interaction = InteractionManager.createInteractionHandle();
      await vi.advanceTimersByTimeAsync(51);
      await settle(f.root);
      expect(f.items()).toHaveLength(9);
      InteractionManager.clearInteractionHandle(interaction);
      await vi.advanceTimersByTimeAsync(1);
      await settle(f.root);
      expect(f.items()).toHaveLength(12);
      expect(f.items()[0]).toBe(first);
      expect(f.input.focusedID).toBe("item-0");
      f.input.dispatch({ key: "select", phase: "up" });
      f.ref.current!.scrollToIndex({ index: 9999, animated: false });
      await settle(f.root);
      expect(f.items().some((node) => node.fields.id === "item-29999")).toBe(true);
      expect(f.items().length % 3).toBe(0);
      expect(f.items().length).toBeLessThan(40);
      await f.render({ ...props, data: f.data.slice(0, 9) });
      expect(f.items().every((node) => Number(String(node.fields.id).slice(5)) < 9)).toBe(true);
    } finally {
      f.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains unchanged row keys, remounts changed row membership and rejects stale activation", async () => {
    const f = fixture(9, 160),
      setups: string[] = [],
      cleanups: string[] = [],
      presses: string[] = [];
    function Cell({ item }: { item: Item }) {
      useLayoutEffect(() => {
        setups.push(item.id);
        return () => {
          cleanups.push(item.id);
        };
      }, []);
      return createElement(Pressable, {
        nativeID: `item-${item.id}`,
        style: { width: 60, height: 20 },
        onPress: () => presses.push(item.id),
      });
    }
    const props = {
      numColumns: 3,
      renderItem: ({ item }: { item: Item }) => createElement(Cell, { item }),
    };
    try {
      await f.render(props);
      const old = f.items().find((node) => node.fields.id === "item-3")!;
      await f.render({
        ...props,
        data: [...f.data.slice(3, 6), ...f.data.slice(0, 3), ...f.data.slice(6)],
      });
      expect(f.items().find((node) => node.fields.id === "item-3")).toBe(old);
      f.scene.emit(old, "focusedChild", "item-3");
      f.input.dispatch({ key: "select", phase: "down" });
      await f.render({
        ...props,
        data: [
          f.data[0],
          f.data[3],
          ...f.data.filter((item) => item.id !== "0" && item.id !== "3"),
        ],
      });
      expect(f.items().find((node) => node.fields.id === "item-3")).not.toBe(old);
      f.scene.emit(old, "focusedChild", "item-3");
      f.input.dispatch({ key: "select", phase: "up" });
      expect(presses).toEqual([]);
      expect(cleanups.filter((id) => id === "3").length).toBeGreaterThan(0);
      await f.render({ ...props, data: f.data.map((item) => ({ ...item, title: "replacement" })) });
      expect(f.items()).toHaveLength(9);
    } finally {
      f.dispose();
    }
    expect(cleanups.length).toBe(setups.length);
  });

  it.each([1, 3])(
    "uses default item IDs across insertion, removal and key reuse (%i columns)",
    async (numColumns) => {
      const f = fixture(9, 160),
        props = { numColumns, keyExtractor: undefined };
      try {
        await f.render(props);
        const first = f.items().find((node) => node.fields.id === "item-0")!;
        const middle = f.items().find((node) => node.fields.id === "item-3")!;
        await f.render({ ...props, data: [...f.data, { id: "9" }] });
        expect(f.items().find((node) => node.fields.id === "item-0")).toBe(first);
        await f.render({ ...props, data: [...f.data.slice(3, 6), ...f.data.slice(0, 3)] });
        expect(f.items().find((node) => node.fields.id === "item-0")).toBe(first);
        expect(f.items().find((node) => node.fields.id === "item-3")).toBe(middle);
        await f.render({ ...props, data: f.data.slice(3, 6) });
        expect(f.scene.nodes.has(first.id)).toBe(false);
        await f.render({ ...props, data: f.data.slice(0, 6).map((item) => ({ ...item })) });
        expect(f.items().find((node) => node.fields.id === "item-0")).not.toBe(first);
        expect(f.items().find((node) => node.fields.id === "item-3")).toBe(middle);
      } finally {
        f.dispose();
      }
    },
  );

  it("measures a bounded incomplete tail before end scrolling and returns to the start", async () => {
    const f = fixture(1001, 60),
      props = {
        numColumns: 3,
        ListHeaderComponent: createElement(View, { nativeID: "header", style: { height: 10 } }),
        ListFooterComponent: createElement(View, { nativeID: "footer", style: { height: 15 } }),
        contentContainerStyle: { paddingTop: 5, paddingBottom: 7 },
      };
    try {
      await f.render(props);
      const before = f.scene.nodes.size;
      f.ref.current!.scrollToEnd({ animated: false });
      await settle(f.root);
      expect(f.rect("item-1000")).toBeDefined();
      expect(f.rect("item-1000")!.y).toBeLessThan(60);
      expect(f.rect("footer")!.y + f.rect("footer")!.height).toBe(53);
      expect(f.scene.nodes.size).toBeLessThan(before + 50);
      f.ref.current!.scrollToOffset({ offset: 0, animated: false });
      await settle(f.root);
      expect(f.rect("item-0")?.y).toBe(15);
      expect(f.rect("item-1000")).toBeUndefined();
    } finally {
      f.dispose();
    }
  });

  it.each([0, -1, 1.5, Infinity, NaN])("rejects invalid column counts (%s)", async (numColumns) => {
    const f = fixture();
    try {
      await expect(f.render({ numColumns })).rejects.toThrow("positive safe integer");
    } finally {
      try {
        f.root.unmount();
      } catch {}
      f.input.dispose();
    }
    expect(f.scene.nodes.size).toBe(1);
    expect(f.scene.listenerCount).toBe(0);
  });

  it.each([
    { numColumns: 2, horizontal: true },
    { numColumns: 1, columnWrapperStyle: {} },
  ])("rejects unsupported combinations (%j)", async (props) => {
    const f = fixture();
    try {
      await expect(f.render(props)).rejects.toThrow(/horizontal|columnWrapperStyle/);
    } finally {
      try {
        f.root.unmount();
      } catch {}
      f.input.dispose();
    }
  });

  it("requires a new list key for column-count changes and cancels the retired window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture(1000);
    try {
      await f.render({ numColumns: 2 });
      await f.render({ numColumns: 3 }, "replacement");
      expect(f.items().length % 3).toBe(0);
      await expect(f.render({ numColumns: 2 }, "replacement")).rejects.toThrow("Change the key");
    } finally {
      try {
        f.root.unmount();
      } catch {}
      f.input.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
    expect(f.scene.listenerCount).toBe(0);
  });
});
