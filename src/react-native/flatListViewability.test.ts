import { createElement, createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { FlatList, type FlatListHandle, type FlatListProps } from "./flatList";
import { createNativeRoot } from "./createNativeRoot";
import { View } from "./primitives";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";

type Item = { id: string };
type Token = { item: Item; key: string; index: number; isViewable: boolean };
type Info = { viewableItems: Token[]; changed: Token[] };
const settle = async (root: ReturnType<typeof createNativeRoot>) => {
  for (let index = 0; index < 6; index++) {
    await root.whenCommitted();
    root.flush();
  }
};
function fixture(horizontal = false, columns = 1) {
  const scene = new RecordingSceneGraph(),
    ref = createRef<FlatListHandle>(),
    callback = vi.fn<(info: Info) => void>(),
    data = Array.from({ length: 101 }, (_, index) => ({ id: String(index) }));
  const root = createNativeRoot(scene, {
    strictMode: true,
    viewport: { width: 400, height: 200 },
    text: { prepare() {}, metrics: () => ({ lineHeight: 20, width: () => 8 }) },
  });
  const render = async (props: Partial<FlatListProps<Item>> = {}, key = "list") => {
    root.render(
      createElement(FlatList<Item>, {
        key,
        ref,
        data,
        horizontal,
        numColumns: columns,
        keyExtractor: (item) => item.id,
        renderItem: ({ item }) =>
          createElement(View, {
            nativeID: "viewable-" + item.id,
            style: horizontal ? { width: 20, height: 20 } : { height: 20 },
          }),
        getItemLayout: (_data, index) => ({ length: 20, offset: index * 20 }),
        initialNumToRender: 1,
        maxToRenderPerBatch: 1,
        updateCellsBatchingPeriod: 60000,
        windowSize: 3,
        showsVerticalScrollIndicator: false,
        showsHorizontalScrollIndicator: false,
        style: horizontal
          ? { width: 50, height: 40, flexGrow: 0, flexShrink: 0 }
          : { width: 400, height: 50, flexGrow: 0, flexShrink: 0 },
        onViewableItemsChanged: callback,
        ...props,
      }),
    );
    await settle(root);
  };
  const move = async (offset: number) => {
    ref.current!.scrollToOffset({ offset, animated: false });
    await settle(root);
  };
  const latest = () => callback.mock.calls.at(-1)?.[0];
  const keys = () => latest()?.viewableItems.map((token) => token.key);
  const dispose = () => {
    root.unmount();
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
  };
  return { root, scene, ref, callback, data, render, move, latest, keys, dispose };
}
afterEach(() => vi.useRealTimers());

it.each([
  {},
  { itemVisiblePercentThreshold: 10, viewAreaCoveragePercentThreshold: 10 },
  { itemVisiblePercentThreshold: -1 },
  { viewAreaCoveragePercentThreshold: 101 },
  { itemVisiblePercentThreshold: NaN },
  { itemVisiblePercentThreshold: 50, minimumViewTime: -1 },
  { itemVisiblePercentThreshold: 50, minimumViewTime: Infinity },
  { itemVisiblePercentThreshold: 50, minimumViewTime: 0x80000000 },
])("rejects an invalid bounded viewability configuration (%j)", async (viewabilityConfig) => {
  const f = fixture();
  try {
    await expect(f.render({ viewabilityConfig })).rejects.toThrow("exactly one finite");
  } finally {
    f.dispose();
  }
});

it("accepts a same-value config and callback replacement but requires remount for changed configuration", async () => {
  const f = fixture();
  try {
    await f.render({ viewabilityConfig: { itemVisiblePercentThreshold: 50 } });
    await f.render({
      viewabilityConfig: { itemVisiblePercentThreshold: 50 },
      onViewableItemsChanged: () => {},
    });
    await expect(
      f.render({ viewabilityConfig: { itemVisiblePercentThreshold: 51 } }),
    ).rejects.toThrow("requires a new key");
    await f.render({ viewabilityConfig: { itemVisiblePercentThreshold: 51 } }, "new-owner");
  } finally {
    f.dispose();
  }
});

it.each([true, false])(
  "requires remount when callback nullability changes (%s)",
  async (enabled) => {
    const f = fixture();
    try {
      await f.render({ onViewableItemsChanged: enabled ? f.callback : undefined });
      await expect(
        f.render({ onViewableItemsChanged: enabled ? undefined : f.callback }),
      ).rejects.toThrow("requires a new key");
    } finally {
      f.dispose();
    }
  },
);

it("rejects multiple callback pairs rather than forwarding them as an unimplemented prop", async () => {
  const f = fixture();
  try {
    await expect(
      f.render({ viewabilityConfigCallbackPairs: [] } as Partial<FlatListProps<Item>>),
    ).rejects.toThrow("Multiple viewability callbacks");
  } finally {
    f.dispose();
  }
});

for (const horizontal of [false, true]) {
  it(`reports bounded ${horizontal ? "horizontal" : "vertical"} tokens and ordered additions/removals`, async () => {
    const f = fixture(horizontal);
    try {
      await f.render();
      expect(f.keys()).toEqual(["0", "1", "2"]);
      expect(f.latest()?.viewableItems[0]).toEqual({
        item: f.data[0],
        key: "0",
        index: 0,
        isViewable: true,
      });
      const count = f.callback.mock.calls.length;
      await f.move(1);
      expect(f.callback).toHaveBeenCalledTimes(count);
      await f.move(20);
      expect(f.keys()).toEqual(["1", "2", "3"]);
      expect(f.latest()?.changed.map((token) => [token.key, token.isViewable])).toEqual([
        ["3", true],
        ["0", false],
      ]);
      const mounted = [...f.scene.nodes.values()].filter((node) =>
        String(node.fields.id).startsWith("viewable-"),
      );
      expect(mounted.length).toBeGreaterThan(2);
      expect(mounted.length).toBeLessThan(35);
    } finally {
      f.dispose();
    }
  });
}

it("distinguishes item and viewport thresholds while always admitting wholly visible items", async () => {
  const f = fixture();
  try {
    await f.render({ viewabilityConfig: { itemVisiblePercentThreshold: 50 } });
    expect(f.keys()).toEqual(["0", "1", "2"]);
    await f.move(1);
    expect(f.keys()).toEqual(["0", "1", "2"]);
    await f.move(11);
    expect(f.keys()).toEqual(["1", "2"]);
    await f.render({ viewabilityConfig: { viewAreaCoveragePercentThreshold: 50 } }, "area");
    expect(f.keys()).toEqual(["0", "1"]);
    await f.move(10);
    expect(f.keys()).toEqual(["1", "2"]);
  } finally {
    f.dispose();
  }
});

it("uses declared item lengths rather than separator stride, plus committed header and padding", async () => {
  const f = fixture();
  try {
    await f.render({
      viewabilityConfig: { itemVisiblePercentThreshold: 50 },
      ListHeaderComponent: createElement(View, { style: { height: 13 } }),
      contentContainerStyle: { paddingTop: 5 },
      ItemSeparatorComponent: () => createElement(View, { style: { height: 4 } }),
      getItemLayout: (_data, index) => ({ length: 20, offset: index * 24 }),
    });
    expect(f.keys()).toEqual(["0"]);
    await f.move(14);
    expect(f.keys()).toEqual(["0", "1"]);
  } finally {
    f.dispose();
  }
});

it("keeps actual viewport tokens when oversized commands clamp to an unchanged zero offset", async () => {
  const f = fixture(false, 3);
  try {
    // ScrollView's default flex growth makes the actual viewport 200px, so this
    // whole short collection is visible even though its authored height is 20.
    await f.render({ data: f.data.slice(0, 8), style: { width: 400, height: 20 } });
    const expected = ["0", "1", "2", "3", "4", "5", "6", "7"];
    expect(f.keys()).toEqual(expected);
    const count = f.callback.mock.calls.length;
    for (let index = 0; index < 2; index++) {
      await f.move(1_000_000);
      expect(f.keys()).toEqual(expected);
      expect(f.callback).toHaveBeenCalledTimes(count);
    }
  } finally {
    f.dispose();
  }
});

it("expands viewable row tokens into original multi-column items, including incomplete tails", async () => {
  const f = fixture(false, 3);
  try {
    await f.render({ data: f.data.slice(0, 8) });
    expect(f.keys()).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
    expect(f.latest()?.viewableItems.map((token) => [token.item, token.index])).toEqual(
      f.data.slice(0, 8).map((item, index) => [item, index]),
    );
    await f.move(10);
    await f.render({
      data: f.data.slice(0, 8),
      style: { width: 400, height: 20, flexGrow: 0, flexShrink: 0 },
    });
    await f.move(40);
    expect(f.keys()).toEqual(["6", "7"]);
    expect(
      f
        .latest()
        ?.changed.filter((token) => !token.isViewable)
        .map((token) => token.key),
    ).toContain("3");
  } finally {
    f.dispose();
  }
});

it("waits for explicit interaction; programmatic scrolling alone does not record a native drag", async () => {
  const f = fixture();
  try {
    await f.render({
      viewabilityConfig: { itemVisiblePercentThreshold: 1, waitForInteraction: true },
    });
    expect(f.callback).not.toHaveBeenCalled();
    await f.move(20);
    expect(f.callback).not.toHaveBeenCalled();
    f.ref.current!.recordInteraction();
    await settle(f.root);
    expect(f.keys()).toEqual(["1", "2", "3"]);
  } finally {
    f.dispose();
  }
});

it("filters delayed sets against current indices using pinned timer semantics", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = fixture();
  try {
    await f.render({ viewabilityConfig: { itemVisiblePercentThreshold: 1, minimumViewTime: 100 } });
    expect(f.callback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(40);
    await f.move(60);
    await vi.advanceTimersByTimeAsync(40);
    await f.move(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(f.keys()).toEqual(["0", "1", "2"]);
    // The pinned helper filters captured indices; it does not restart a strict dwell timer.
    await vi.advanceTimersByTimeAsync(40);
    expect(f.keys()).toEqual([]);
    await vi.advanceTimersByTimeAsync(40);
    expect(f.keys()).toEqual(["0", "1", "2"]);
  } finally {
    f.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("uses the current callback for pending delivery and cancels a replaced data generation", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = fixture(),
    next = vi.fn<(info: Info) => void>();
  const config = { itemVisiblePercentThreshold: 1, minimumViewTime: 100 };
  try {
    await f.render({ viewabilityConfig: config });
    await vi.advanceTimersByTimeAsync(50);
    await f.render({ viewabilityConfig: { ...config }, onViewableItemsChanged: next });
    await vi.advanceTimersByTimeAsync(50);
    expect(f.callback).not.toHaveBeenCalled();
    expect(next.mock.calls.at(-1)?.[0].viewableItems.map((token) => token.key)).toEqual([
      "0",
      "1",
      "2",
    ]);
    await f.move(60);
    const replacement = f.data.map((item) => ({ id: "new-" + item.id }));
    await vi.advanceTimersByTimeAsync(50);
    await f.render({ data: replacement, viewabilityConfig: config, onViewableItemsChanged: next });
    const count = next.mock.calls.length;
    await vi.advanceTimersByTimeAsync(50);
    expect(next).toHaveBeenCalledTimes(count);
    await vi.advanceTimersByTimeAsync(50);
    expect(next.mock.calls.at(-1)?.[0].viewableItems.map((token) => token.key)).toEqual([
      "new-3",
      "new-4",
      "new-5",
    ]);
  } finally {
    f.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("retires pending callbacks and imperative interaction authority on unmount", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = fixture();
  await f.render({ viewabilityConfig: { itemVisiblePercentThreshold: 1, minimumViewTime: 100 } });
  const stale = f.ref.current!;
  f.dispose();
  stale.recordInteraction();
  await vi.advanceTimersByTimeAsync(200);
  expect(f.callback).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("resets changed-data indices but preserves key identity and pinned empty-data silence", async () => {
  const f = fixture();
  try {
    await f.render();
    const count = f.callback.mock.calls.length;
    await f.render({ data: f.data.map((item) => ({ ...item })), extraData: 1 });
    expect(f.callback).toHaveBeenCalledTimes(count);
    await f.render({ data: [] });
    expect(f.callback).toHaveBeenCalledTimes(count);
    await f.render({ data: [{ id: "new" }] });
    expect(f.keys()).toEqual(["new"]);
    expect(f.latest()?.changed.map((token) => [token.key, token.isViewable])).toEqual([
      ["new", true],
      ["0", false],
      ["1", false],
      ["2", false],
    ]);
  } finally {
    f.dispose();
  }
});
