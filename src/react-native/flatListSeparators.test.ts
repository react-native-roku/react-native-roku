import { createElement, createRef } from "react";
import { expect, it } from "vitest";
import { createNativeRoot } from "./createNativeRoot";
import { FlatList, type FlatListHandle, type FlatListProps } from "./flatList";
import { View } from "./primitives";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";

type Item = { id: string; caption?: string };
type Separators = Parameters<FlatListProps<Item>["renderItem"]>[0]["separators"];
type SeparatorProps = { highlighted: boolean; leadingItem: Item | readonly Item[]; stamp?: string };
const settle = async (root: ReturnType<typeof createNativeRoot>) => {
  for (let index = 0; index < 6; index++) {
    await root.whenCommitted();
    root.flush();
  }
};
function fixture() {
  const scene = new RecordingSceneGraph(),
    ref = createRef<FlatListHandle>(),
    data = ["a", "b", "c", "d"].map((id) => ({ id })),
    controls = new Map<string, Separators>(),
    observed = new Map<string, SeparatorProps>();
  const root = createNativeRoot(scene, {
    strictMode: true,
    viewport: { width: 400, height: 100 },
    text: {
      prepare() {},
      metrics: () => ({ lineHeight: 20, width: (value: string) => value.length * 8 }),
    },
  });
  const Separator = (props: SeparatorProps) => {
    const key = Array.isArray(props.leadingItem)
      ? props.leadingItem.map((item) => item.id).join(":")
      : (props.leadingItem as Item)?.id;
    observed.set(key, props);
    return createElement(View, { style: { height: 4 } });
  };
  const render = async (props: Partial<FlatListProps<Item>> = {}, key = "list") => {
    observed.clear();
    root.render(
      createElement(FlatList<Item>, {
        key,
        ref,
        data,
        keyExtractor: (item) => item.id,
        initialNumToRender: 4,
        showsVerticalScrollIndicator: false,
        ItemSeparatorComponent: Separator,
        renderItem: ({ item, separators }) => {
          controls.set(item.id, separators);
          return createElement(View, {
            nativeID: "item-" + item.id,
            style: { height: 20, width: 80 },
          });
        },
        style: { width: 400, height: 100, flexGrow: 0, flexShrink: 0 },
        ...props,
      }),
    );
    await settle(root);
  };
  const dispose = () => {
    root.unmount();
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
  };
  return { scene, ref, data, controls, observed, root, render, dispose };
}

it("delivers upstream separator controls and updates both adjacent mounted separators", async () => {
  const f = fixture();
  try {
    await f.render();
    expect([...f.observed.keys()]).toEqual(["a", "b", "c"]);
    for (const [key, props] of f.observed)
      expect(props).toEqual({
        highlighted: false,
        leadingItem: f.data.find((item) => item.id === key),
      });
    const b = f.controls.get("b")!;
    expect(b).toMatchObject({
      highlight: expect.any(Function),
      unhighlight: expect.any(Function),
      updateProps: expect.any(Function),
    });
    b.highlight();
    await settle(f.root);
    expect(f.observed.get("a")?.highlighted).toBe(true);
    expect(f.observed.get("b")?.highlighted).toBe(true);
    expect(f.observed.get("c")?.highlighted).toBe(false);
    b.updateProps("leading", { stamp: "left" });
    b.updateProps("trailing", { stamp: "right" });
    await settle(f.root);
    expect(f.observed.get("a")?.stamp).toBe("left");
    expect(f.observed.get("b")?.stamp).toBe("right");
    b.unhighlight();
    await settle(f.root);
    expect(f.observed.get("a")).toMatchObject({ highlighted: false, stamp: "left" });
    expect(f.observed.get("b")).toMatchObject({ highlighted: false, stamp: "right" });
    f.controls.get("a")!.updateProps("leading", { stamp: "outside" });
    f.controls.get("d")!.highlight();
    await settle(f.root);
    expect(f.observed.get("c")?.highlighted).toBe(true);
    expect([...f.observed.values()].some((props) => props.stamp === "outside")).toBe(false);
  } finally {
    f.dispose();
  }
});

it("retains keyed separator state while refreshing its item and adjacent-key mapping", async () => {
  const f = fixture();
  try {
    await f.render();
    const b = f.controls.get("b")!;
    b.updateProps("trailing", { stamp: "retained", leadingItem: { id: "wrong" } });
    await settle(f.root);
    expect(f.observed.get("b")?.stamp).toBe("retained");
    expect(f.observed.has("wrong")).toBe(false);
    const replacement = { id: "b", caption: "new" };
    await f.render({ data: [f.data[2], replacement, f.data[0], f.data[3]], extraData: 1 });
    expect(f.controls.get("b")).toBe(b);
    expect(f.observed.get("b")).toMatchObject({ stamp: "retained", leadingItem: replacement });
    b.highlight();
    await settle(f.root);
    expect(f.observed.get("c")?.highlighted).toBe(true);
    expect(f.observed.get("b")?.highlighted).toBe(true);
    expect(f.observed.get("a")?.highlighted).toBe(false);
  } finally {
    f.dispose();
  }
});

it("fences callbacks from retired cells even when their keys return in the same mounted list", async () => {
  const f = fixture();
  try {
    await f.render();
    const retired = f.controls.get("b")!;
    await f.render({ data: [f.data[0], f.data[2], f.data[3]] });
    await f.render();
    const returned = f.controls.get("b")!;
    expect(returned).not.toBe(retired);
    retired.highlight();
    retired.updateProps("leading", { stamp: "stale" });
    await settle(f.root);
    for (const props of f.observed.values()) expect(props).toMatchObject({ highlighted: false });
    expect([...f.observed.values()].some((props) => props.stamp === "stale")).toBe(false);
    returned.highlight();
    await settle(f.root);
    expect(f.observed.get("b")?.highlighted).toBe(true);
    f.root.unmount();
    const operations = f.scene.operations.length;
    returned.unhighlight();
    await settle(f.root);
    expect(f.scene.operations.length).toBe(operations);
  } finally {
    f.dispose();
  }
});

it("shares row controls across columns and supplies row-array separator metadata", async () => {
  const f = fixture();
  try {
    await f.render({
      data: [...f.data, { id: "e" }],
      numColumns: 2,
      columnWrapperStyle: { columnGap: 4 },
    });
    expect(f.controls.get("a")).toBe(f.controls.get("b"));
    expect(f.controls.get("c")).toBe(f.controls.get("d"));
    expect([...f.observed.keys()]).toEqual(["a:b", "c:d"]);
    f.controls.get("d")!.highlight();
    await settle(f.root);
    expect(f.observed.get("a:b")?.highlighted).toBe(true);
    expect(f.observed.get("c:d")?.highlighted).toBe(true);
  } finally {
    f.dispose();
  }
});

it("passes element separators through without injected control props and supports horizontal adjacency", async () => {
  const f = fixture();
  try {
    await f.render({
      horizontal: true,
      ItemSeparatorComponent: createElement(View, {
        nativeID: undefined,
        style: { width: 4, height: 20 },
      }),
    });
    f.controls.get("b")!.highlight();
    await settle(f.root);
    expect(f.controls.size).toBe(4);
    await f.render({ horizontal: true, ItemSeparatorComponent: undefined });
    f.controls.get("b")!.updateProps("trailing", { stamp: "no component" });
    await settle(f.root);
  } finally {
    f.dispose();
  }
});

it("remeasures separator size changes without replacing current native items", async () => {
  const f = fixture();
  const position = (id: string) => {
    let node = [...f.scene.nodes.values()].find((node) => node.fields.id === id)!,
      y = 0;
    while (node) {
      y += Number((node.fields.translation as number[] | undefined)?.[1] ?? 0);
      node = node.parent!;
    }
    return y;
  };
  try {
    await f.render({
      ItemSeparatorComponent: ({ highlighted }: { highlighted: boolean }) =>
        createElement(View, { style: { height: highlighted ? 8 : 4 } }),
    });
    const c = [...f.scene.nodes.values()].find((node) => node.fields.id === "item-c")!;
    expect(position("item-c")).toBe(48);
    f.controls.get("b")!.highlight();
    await settle(f.root);
    expect(position("item-c")).toBe(56);
    expect(f.scene.nodes.get(c.id)).toBe(c);
    f.controls.get("b")!.unhighlight();
    await settle(f.root);
    expect(position("item-c")).toBe(48);
  } finally {
    f.dispose();
  }
});

it("retires offscreen controller authority before a virtualized key returns", async () => {
  const f = fixture(),
    data = Array.from({ length: 1001 }, (_, index) => ({ id: String(index) }));
  const props = {
    data,
    initialNumToRender: 1,
    windowSize: 3,
    maxToRenderPerBatch: 1,
    updateCellsBatchingPeriod: 60000,
    getItemLayout: (_items: readonly Item[] | null | undefined, index: number) => ({
      index,
      length: 20,
      offset: index * 24,
    }),
  };
  try {
    await f.render(props);
    const retired = f.controls.get("0")!;
    f.ref.current!.scrollToIndex({ index: 500, animated: false });
    await settle(f.root);
    expect([...f.scene.nodes.values()].some((node) => node.fields.id === "item-0")).toBe(false);
    f.ref.current!.scrollToIndex({ index: 0, animated: false });
    await settle(f.root);
    const current = f.controls.get("0")!;
    expect(current).not.toBe(retired);
    retired.highlight();
    retired.updateProps("trailing", { stamp: "offscreen" });
    await settle(f.root);
    expect(f.observed.get("0")).toMatchObject({ highlighted: false });
    expect(f.observed.get("0")?.stamp).not.toBe("offscreen");
    current.highlight();
    await settle(f.root);
    expect(f.observed.get("0")?.highlighted).toBe(true);
  } finally {
    f.dispose();
  }
});
