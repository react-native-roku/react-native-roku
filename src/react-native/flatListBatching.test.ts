import { createElement, createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeRoot } from "./createNativeRoot";
import { FlatList, type FlatListHandle } from "./flatList";
import { View, Pressable } from "./primitives";
import { NativeInput } from "./NativeInput";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import { InteractionManager } from "./interactionManager";
import type { NativeViewHandle } from "./nativeViewHandle";

const settle = async (root: ReturnType<typeof createNativeRoot>) => {
  for (let index = 0; index < 5; index++) {
    await root.whenCommitted();
    root.flush();
  }
};

function fixture(height = 40) {
  const scene = new RecordingSceneGraph();
  const input = new NativeInput();
  const root = createNativeRoot(scene, {
    viewport: { width: 400, height },
    strictMode: true,
    input,
    text: {
      prepare() {},
      metrics: () => ({ lineHeight: 20, width: (text: string) => text.length * 8 }),
    },
  });
  const list = createRef<FlatListHandle>();
  const items = Array.from({ length: 100 }, (_, index) => String(index));
  const render = (data = items, batch = 2, period = 50) =>
    root.render(
      createElement(FlatList<string>, {
        ref: list,
        data,
        keyExtractor: (item) => item,
        renderItem: ({ item }) =>
          createElement(View, { nativeID: `row-${item}`, style: { height: 20 } }),
        getItemLayout: (_data, index) => ({ index, length: 20, offset: index * 20 }),
        initialNumToRender: 2,
        maxToRenderPerBatch: batch,
        updateCellsBatchingPeriod: period,
        windowSize: 7,
        showsVerticalScrollIndicator: false,
        style: { width: 400, height },
      }),
    );
  const rows = () =>
    [...scene.nodes.values()].filter((node) => String(node.fields.id).startsWith("row-"));
  return { scene, root, list, items, render, rows, input };
}

afterEach(() => vi.useRealTimers());

describe("incremental keyed collection rendering", () => {
  it("does not select an offscreen row as an anchor while the header fills the viewport", async () => {
    const f = fixture(),
      header = createRef<NativeViewHandle>();
    const render = (data: string[]) =>
      f.root.render(
        createElement(FlatList<string>, {
          data,
          keyExtractor: (item) => item,
          renderItem: ({ item }) =>
            createElement(View, { nativeID: `row-${item}`, style: { height: 20 } }),
          getItemLayout: (_data, index) => ({ length: 20, offset: index * 20 }),
          maintainVisibleContentPosition: { minIndexForVisible: 0 },
          ListHeaderComponent: createElement(View, { ref: header, style: { height: 60 } }),
          showsVerticalScrollIndicator: false,
          style: { width: 400, height: 40 },
        }),
      );
    try {
      render(f.items);
      await settle(f.root);
      const positions: number[] = [];
      header.current!.measureInWindow((_x, y) => positions.push(y));
      render(["prepended", ...f.items]);
      await settle(f.root);
      header.current!.measureInWindow((_x, y) => positions.push(y));
      expect(positions).toEqual([0, 0]);
    } finally {
      f.root.unmount();
      f.input.dispose();
    }
  });

  it("fills the visible viewport immediately even when its rows exceed the offscreen batch budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture(120);
    try {
      f.render();
      await settle(f.root);
      expect(f.rows().map((node) => node.fields.id)).toEqual([
        "row-0",
        "row-1",
        "row-2",
        "row-3",
        "row-4",
        "row-5",
      ]);
      await vi.advanceTimersByTimeAsync(51);
      await settle(f.root);
      expect(f.rows()).toHaveLength(8);
    } finally {
      f.root.unmount();
      f.input.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replaces queued work when the batch limit and interval change", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    try {
      f.render();
      await settle(f.root);
      f.render(f.items, 3, 10);
      await settle(f.root);
      await vi.advanceTimersByTimeAsync(9);
      await settle(f.root);
      expect(f.rows()).toHaveLength(2);
      for (const count of [5, 8, 9]) {
        await vi.advanceTimersByTimeAsync(11);
        await settle(f.root);
        expect(f.rows()).toHaveLength(count);
      }
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      f.root.unmount();
      f.input.dispose();
    }
  });

  it("keeps an observed focused control and held press alive while more keyed rows mount", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture(),
      presses: string[] = [];
    try {
      f.root.render(
        createElement(FlatList<string>, {
          data: f.items,
          keyExtractor: (item) => item,
          renderItem: ({ item }) =>
            createElement(Pressable, {
              nativeID: `row-${item}`,
              onPress: () => presses.push(item),
              style: { height: 20 },
            }),
          getItemLayout: (_data, index) => ({ length: 20, offset: index * 20 }),
          initialNumToRender: 2,
          maxToRenderPerBatch: 2,
          windowSize: 7,
          showsVerticalScrollIndicator: false,
          style: { width: 400, height: 40 },
        }),
      );
      await settle(f.root);
      const first = f.rows()[0];
      f.scene.emit(first, "focusedChild", "row-0");
      f.input.dispatch({ key: "select", phase: "down" });
      await vi.advanceTimersByTimeAsync(51);
      await settle(f.root);
      expect(f.rows()).toHaveLength(4);
      expect(f.rows()[0]).toBe(first);
      expect(f.input.focusedID).toBe("row-0");
      f.input.dispatch({ key: "select", phase: "up" });
      expect(presses).toEqual(["0"]);
    } finally {
      f.root.unmount();
      f.input.dispose();
    }
    expect(f.scene.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts at a declared initial item after the header and content inset are measured", async () => {
    const f = fixture();
    const data = f.items;
    const target = createRef<NativeViewHandle>();
    const header = createRef<NativeViewHandle>();
    try {
      f.root.render(
        createElement(FlatList<string>, {
          ref: f.list,
          data,
          initialScrollIndex: 50,
          initialNumToRender: 2,
          getItemLayout: (_data, index) => ({ index, length: 20, offset: index * 20 }),
          renderItem: ({ item }) =>
            createElement(View, {
              ref: item === "50" ? target : undefined,
              nativeID: `row-${item}`,
              style: { height: 20 },
            }),
          ListHeaderComponent: createElement(View, { ref: header, style: { height: 30 } }),
          contentContainerStyle: { paddingTop: 10 },
          showsVerticalScrollIndicator: false,
          style: { width: 400, height: 40 },
        }),
      );
      await settle(f.root);
      expect(f.rows().map((node) => node.fields.id)).toContain("row-50");
      const row = f.rows().find((node) => node.fields.id === "row-50")!;
      expect(row.fields.translation).toEqual([0, 0]);
      const positions: number[] = [];
      target.current!.measureInWindow((_x, y) => positions.push(y));
      expect(positions).toEqual([0]);
      const before = row;
      f.list.current!.scrollToOffset({ offset: 0, animated: false });
      await settle(f.root);
      const headerPositions: number[] = [];
      header.current!.measureInWindow((_x, y) => headerPositions.push(y));
      expect(headerPositions).toEqual([10]);
      expect(f.rows().includes(before)).toBe(false);
      // Header plus leading inset fills this viewport at offset zero. The
      // first data row becomes visible after crossing that measured extent.
      f.list.current!.scrollToOffset({ offset: 40, animated: false });
      await settle(f.root);
      expect(f.rows().some((node) => node.fields.id === "row-0")).toBe(true);
    } finally {
      f.root.unmount();
    }
    expect(f.scene.nodes.size).toBe(1);
  });

  it("preserves the first eligible visible anchor and ignores rows below the configured minimum", async () => {
    const f = fixture();
    const prepend = createRef<NativeViewHandle>(),
      targetRef = createRef<NativeViewHandle>();
    const render = (data: string[]) =>
      f.root.render(
        createElement(FlatList<string>, {
          ref: f.list,
          data,
          keyExtractor: (item) => item,
          getItemLayout: (_data, index) => ({ index, length: 20, offset: index * 20 }),
          renderItem: ({ item }) =>
            createElement(View, {
              ref: item === "first-prepend" ? prepend : item === "4" ? targetRef : undefined,
              nativeID: `row-${item}`,
              style: { height: 20 },
            }),
          maintainVisibleContentPosition: { minIndexForVisible: 3 },
          initialNumToRender: 2,
          showsVerticalScrollIndicator: false,
          style: { width: 400, height: 40 },
        }),
      );
    try {
      render(f.items);
      await settle(f.root);
      render(["first-prepend", ...f.items]);
      await settle(f.root);
      expect(f.rows().map((node) => node.fields.id)).toContain("row-first-prepend");
      const leading: number[] = [];
      prepend.current!.measureInWindow((_x, y) => leading.push(y));
      expect(leading).toEqual([0]);
      f.list.current!.scrollToIndex({ index: 5, animated: false });
      await settle(f.root);
      const target = f.rows().find((node) => node.fields.id === "row-4")!;
      const positions: number[] = [];
      targetRef.current!.measureInWindow((_x, y) => positions.push(y));
      render(["second-prepend", "first-prepend", ...f.items]);
      await settle(f.root);
      targetRef.current!.measureInWindow((_x, y) => positions.push(y));
      expect(positions).toEqual([0, 0]);
      expect(f.rows().find((node) => node.fields.id === "row-4")).toBe(target);
    } finally {
      f.root.unmount();
    }
    expect(f.scene.nodes.size).toBe(1);
  });

  it("bounds offscreen additions per delayed batch and retains existing native row identity", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    try {
      f.render();
      await settle(f.root);
      expect(f.rows().map((node) => node.fields.id)).toEqual(["row-0", "row-1"]);
      const first = f.rows()[0];
      await vi.advanceTimersByTimeAsync(49);
      await settle(f.root);
      expect(f.rows()).toHaveLength(2);
      for (const count of [4, 6, 8, 9]) {
        await vi.advanceTimersByTimeAsync(51);
        await settle(f.root);
        expect(f.rows()).toHaveLength(count);
        expect(f.rows()[0]).toBe(first);
      }
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      f.root.unmount();
    }
    expect(f.scene.nodes.size).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires one old edge row in the same batch as offscreen additions", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    const has = (index: number) => f.rows().some((node) => node.fields.id === `row-${index}`);
    async function scrollTo(offset: number) {
      f.list.current!.scrollToOffset({ offset, animated: false });
      await settle(f.root);
    }
    try {
      f.render();
      await settle(f.root);
      await vi.advanceTimersByTimeAsync(400);
      await settle(f.root);
      await scrollTo(140);
      await vi.advanceTimersByTimeAsync(400);
      await settle(f.root);
      expect(has(0)).toBe(true);
      expect(has(8)).toBe(true);
      expect(has(9)).toBe(true);

      await scrollTo(160);
      expect(has(0)).toBe(true);
      expect(has(8)).toBe(true);
      expect(has(9)).toBe(true);
      await vi.advanceTimersByTimeAsync(60);
      await settle(f.root);
      expect(has(0)).toBe(false);
      expect(has(8)).toBe(true);
      expect(has(9)).toBe(true);
    } finally {
      f.root.unmount();
      f.input.dispose();
    }
    expect(f.scene.nodes.size).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the next focusable row mounted during successive scrolls before the overscan timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    const find = (index: number) => f.rows().find((node) => node.fields.id === `row-${index}`);
    try {
      f.root.render(
        createElement(FlatList<string>, {
          ref: f.list,
          data: f.items,
          keyExtractor: (item) => item,
          renderItem: ({ item, index }) =>
            createElement(Pressable, {
              nativeID: `row-${item}`,
              onFocus() {
                if (index > 1)
                  f.list.current!.scrollToOffset({ offset: (index - 1) * 20, animated: false });
              },
              style: { width: 40, height: 20 },
            }),
          getItemLayout: (_data, index) => ({ length: 20, offset: index * 20 }),
          initialNumToRender: 2,
          maxToRenderPerBatch: 2,
          updateCellsBatchingPeriod: 50,
          showsVerticalScrollIndicator: false,
          style: { width: 400, height: 40 },
        }),
      );
      await settle(f.root);
      await vi.advanceTimersByTimeAsync(51);
      await settle(f.root);
      expect(f.rows()).toHaveLength(4);
      f.scene.emit(find(0)!, "focusedChild", "row-0");
      for (let index = 1; index <= 6; index++) {
        const next = find(index);
        expect(next, `destination ${index} should already be mounted`).toBeDefined();
        expect(f.input.dispatch({ key: "down", phase: "down" })).toBe(true);
        expect(next!.fields.gainFocus).toBe(true);
        f.scene.emit(next!, "focusedChild", `row-${index}`);
        await settle(f.root);
        expect(f.input.focusedID).toBe(`row-${index}`);
      }
    } finally {
      f.root.unmount();
      f.input.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("prioritizes a distant visible destination and retires batches for an obsolete data window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    try {
      f.render();
      await settle(f.root);
      f.list.current!.scrollToIndex({ index: 50, animated: false });
      await settle(f.root);
      expect(f.rows().map((node) => node.fields.id)).toEqual(["row-50", "row-51"]);
      await vi.advanceTimersByTimeAsync(51);
      await settle(f.root);
      expect(f.rows()).toHaveLength(4);
      f.render(["replacement-a", "replacement-b", "replacement-c"]);
      await settle(f.root);
      await vi.advanceTimersByTimeAsync(500);
      await settle(f.root);
      expect(f.rows().every((node) => String(node.fields.id).startsWith("row-replacement-"))).toBe(
        true,
      );
      expect(f.rows()).toHaveLength(3);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      f.root.unmount();
    }
    expect(f.scene.nodes.size).toBe(1);
    expect(f.scene.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("defers offscreen work through explicit interactions and cancels it when the root retires", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture(),
      interaction = InteractionManager.createInteractionHandle();
    try {
      f.render();
      await settle(f.root);
      await vi.advanceTimersByTimeAsync(200);
      await settle(f.root);
      expect(f.rows()).toHaveLength(2);
      InteractionManager.clearInteractionHandle(interaction);
      await vi.advanceTimersByTimeAsync(1);
      await settle(f.root);
      expect(f.rows()).toHaveLength(4);
      f.root.unmount();
      await vi.advanceTimersByTimeAsync(500);
      expect(f.scene.nodes.size).toBe(1);
      expect(f.scene.listenerCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      InteractionManager.clearInteractionHandle(interaction);
      f.root.unmount();
    }
  });
});
