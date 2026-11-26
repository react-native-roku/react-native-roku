import { createElement, createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { FlatList, type FlatListHandle, type FlatListProps } from "./flatList";
import { createNativeRoot } from "./createNativeRoot";
import { NativeInput } from "./NativeInput";
import { Pressable, View } from "./primitives";
import type { NativeViewHandle } from "./nativeViewHandle";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";

const settle = async (root: ReturnType<typeof createNativeRoot>) => {
  for (let index = 0; index < 6; index++) {
    await root.whenCommitted();
    root.flush();
  }
};
const generator = (seed: number) => () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed >>> 0;
};
type Item = { id: string };
function fixture(horizontal: boolean, columns: number, initialScrollIndex = 0) {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput(),
    list = createRef<FlatListHandle>(),
    handles = new Map<string, NativeViewHandle>(),
    activations: string[] = [];
  const state = {
    data: Array.from({ length: 101 }, (_, index) => ({ id: String(index) })),
    viewport: 60,
    header: 13,
    footer: 9,
    leading: 5,
    trailing: 7,
    offset: 0,
  };
  let observedOffset = 0,
    serial = 0;
  const root = createNativeRoot(scene, {
    input,
    strictMode: true,
    viewport: { width: 400, height: 200 },
    text: {
      prepare() {},
      metrics: () => ({ lineHeight: 20, width: () => 8 }),
    },
  });
  const size = (length: number) =>
    horizontal ? { width: length, height: 20 } : { height: length, width: 80 };
  const rows = () => Math.ceil(state.data.length / columns);
  const maximum = () =>
    Math.max(
      0,
      state.leading +
        state.header +
        Math.max(0, rows() * 24 - 4) +
        state.footer +
        state.trailing -
        state.viewport,
    );
  const render = async (overrides: Partial<FlatListProps<Item>> = {}) => {
    root.render(
      createElement(FlatList<Item>, {
        ref: list,
        initialScrollIndex,
        data: state.data,
        horizontal,
        numColumns: columns,
        columnWrapperStyle: columns > 1 ? { columnGap: 4 } : undefined,
        keyExtractor: (item, index) => {
          expect(item).toBe(state.data[index]);
          return item.id;
        },
        renderItem: ({ item, index }) => {
          expect(item).toBe(state.data[index]);
          return createElement(Pressable, {
            nativeID: "replay-" + item.id,
            style: horizontal ? { width: 20, height: 20 } : { width: 80, height: 20 },
            ref: (handle) => {
              if (handle) handles.set(item.id, handle);
              else handles.delete(item.id);
            },
            onPress: () => activations.push(item.id),
          });
        },
        getItemLayout: (original, index) => {
          expect(original).toBe(state.data);
          return { index, length: 20, offset: index * 24 };
        },
        ItemSeparatorComponent: () => createElement(View, { style: size(4) }),
        ListHeaderComponent: state.header
          ? createElement(View, { style: size(state.header) })
          : null,
        ListFooterComponent: state.footer
          ? createElement(View, { style: size(state.footer) })
          : null,
        contentContainerStyle: horizontal
          ? { paddingLeft: state.leading, paddingRight: state.trailing }
          : { paddingTop: state.leading, paddingBottom: state.trailing },
        style: horizontal
          ? { width: state.viewport, height: 40, flexGrow: 0, flexShrink: 0 }
          : { width: 400, height: state.viewport, flexGrow: 0, flexShrink: 0 },
        initialNumToRender: 1,
        maxToRenderPerBatch: 1,
        windowSize: 3,
        updateCellsBatchingPeriod: 60000,
        showsVerticalScrollIndicator: false,
        showsHorizontalScrollIndicator: false,
        onScroll: (event) => {
          observedOffset = event.nativeEvent.contentOffset[horizontal ? "x" : "y"];
        },
        ...overrides,
      }),
    );
    await settle(root);
  };
  const position = (id: string) => {
    let value: { x: number; y: number; width: number; height: number } | undefined;
    handles.get(id)?.measureInWindow((x, y, width, height) => {
      value = { x, y, width, height };
    });
    return value;
  };
  const check = () => {
    expect(observedOffset).toBe(state.offset);
    expect(handles.size).toBeLessThan(32 * columns);
    for (let row = 0; row < rows(); row++) {
      const start = state.leading + state.header + row * 24 - state.offset;
      if (start >= state.viewport || start + 20 <= 0) continue;
      for (let column = 0; column < columns; column++) {
        const item = state.data[row * columns + column];
        if (!item) continue;
        const rect = position(item.id);
        expect(
          rect,
          "visible item " +
            item.id +
            "; native=" +
            [...scene.nodes.values()]
              .filter((node) => String(node.fields.id).startsWith("replay-"))
              .map((node) => node.fields.id)
              .join(",") +
            "; refs=" +
            [...handles.keys()].join(","),
        ).toBeDefined();
        expect(rect?.[horizontal ? "x" : "y"]).toBe(start);
      }
    }
  };
  const index = async (row: number, viewPosition = 0, viewOffset = 0) => {
    state.offset = Math.min(
      maximum(),
      Math.max(
        0,
        state.leading + state.header + row * 24 - (state.viewport - 20) * viewPosition - viewOffset,
      ),
    );
    list.current!.scrollToIndex({ index: row, viewPosition, viewOffset, animated: false });
    await settle(root);
  };
  const replace = (operation: number) => {
    if (operation === 0) state.data = [{ id: "new-" + serial++ }, ...state.data];
    else if (operation === 1 && state.data.length > 12) state.data = state.data.slice(3);
    else if (operation === 2) state.data = [...state.data.slice(7), ...state.data.slice(0, 7)];
    else state.data = state.data.map((item) => ({ ...item }));
    state.offset = Math.min(state.offset, maximum());
  };
  const dispose = () => {
    root.unmount();
    input.dispose();
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
    expect(input.targetCount).toBe(0);
    expect(handles.size).toBe(0);
  };
  return {
    root,
    input,
    scene,
    list,
    state,
    handles,
    activations,
    render,
    position,
    check,
    index,
    replace,
    maximum,
    dispose,
  };
}
afterEach(() => vi.useRealTimers());

it.each([
  [false, 1],
  [false, 2],
  [false, 3],
  [true, 1],
] as const)(
  "preserves a visible end anchor while a large prepend grows the committed extent (axis=%s columns=%s)",
  async (horizontal, columns) => {
    const f = fixture(horizontal, columns),
      props = { maintainVisibleContentPosition: { minIndexForVisible: 0 } };
    try {
      await f.render(props);
      f.state.offset = f.maximum();
      f.list.current!.scrollToEnd({ animated: false });
      await settle(f.root);
      const row = Math.floor((f.state.offset - f.state.leading - f.state.header) / 24),
        key = f.state.data[row * columns].id,
        owner = f.handles.get(key),
        before = f.position(key);
      f.state.data = [
        ...Array.from({ length: 40 * columns }, (_, index) => ({ id: "prepend-" + index })),
        ...f.state.data,
      ];
      f.state.offset += 40 * 24;
      await f.render(props);
      f.check();
      expect(f.handles.get(key)).toBe(owner);
      expect(f.position(key)).toEqual(before);
    } finally {
      f.dispose();
    }
  },
);

it.each([
  [false, 1],
  [false, 2],
  [false, 3],
  [true, 1],
] as const)(
  "preserves every visible row after repeated clamped commands (axis=%s columns=%s)",
  async (horizontal, columns) => {
    const f = fixture(horizontal, columns);
    try {
      await f.render();
      f.state.offset = f.maximum();
      f.list.current!.scrollToEnd({ animated: false });
      await settle(f.root);
      f.check();
      const last = Math.ceil(f.state.data.length / columns) - 1;
      await f.index(last);
      f.check();
      await f.index(last);
      f.check();
      for (let index = 0; index < 2; index++) {
        f.list.current!.scrollToOffset({ offset: 1_000_000, animated: false });
        await settle(f.root);
        f.check();
      }
    } finally {
      f.dispose();
    }
  },
);

it.each([
  [false, 1],
  [false, 2],
  [false, 3],
  [true, 1],
] as const)(
  "aligns declared item length independently of separator stride (%s/%s)",
  async (horizontal, columns) => {
    const f = fixture(horizontal, columns);
    try {
      await f.render();
      await f.index(10, 0.5);
      f.check();
      expect(f.position(f.state.data[10 * columns].id)?.[horizontal ? "x" : "y"]).toBe(20);
    } finally {
      f.dispose();
    }
  },
);

it.each([false, true])(
  "retires removed header geometry before subsequent scroll commands (%s)",
  async (horizontal) => {
    const f = fixture(horizontal, 1);
    try {
      await f.render();
      f.state.header = 0;
      await f.render();
      await f.index(10);
      f.check();
      expect(f.position("10")?.[horizontal ? "x" : "y"]).toBe(0);
    } finally {
      f.dispose();
    }
  },
);

it.each([false, true])(
  "keeps the actual trailing extent after repeated End and a prepend (%s)",
  async (horizontal) => {
    const f = fixture(horizontal, 1);
    try {
      await f.render();
      f.state.offset = f.maximum();
      f.list.current!.scrollToEnd({ animated: false });
      await settle(f.root);
      f.list.current!.scrollToEnd({ animated: false });
      await settle(f.root);
      f.replace(0);
      await f.render();
      f.check();
    } finally {
      f.dispose();
    }
  },
);

it.each([false, true])(
  "defers an initial index until a newly added header is measured (%s)",
  async (horizontal) => {
    const f = fixture(horizontal, 1, 10),
      data = f.state.data;
    try {
      f.state.data = [];
      f.state.header = 0;
      await f.render();
      f.state.data = data;
      f.state.header = 13;
      f.state.offset = 258;
      await f.render();
      f.check();
      expect(f.position("10")?.[horizontal ? "x" : "y"]).toBe(0);
    } finally {
      f.dispose();
    }
  },
);

it.each([false, true])(
  "waits for committed content when initial data arrives without a header (%s)",
  async (horizontal) => {
    const f = fixture(horizontal, 1, 10),
      data = f.state.data;
    try {
      f.state.data = [];
      f.state.header = 0;
      await f.render();
      f.state.data = data;
      f.state.offset = 245;
      await f.render();
      f.check();
    } finally {
      f.dispose();
    }
  },
);

it.each([false, true])(
  "lets an explicit command supersede a deferred initial data jump (%s)",
  async (horizontal) => {
    const f = fixture(horizontal, 1, 10),
      data = f.state.data;
    try {
      f.state.data = [];
      f.state.header = 0;
      await f.render();
      f.state.data = data;
      const rendering = f.render();
      f.list.current!.scrollToOffset({ offset: 0, animated: false });
      await rendering;
      await settle(f.root);
      f.check();
    } finally {
      f.dispose();
    }
  },
);

it.each([
  [false, 1, 0x51eed],
  [false, 2, 0xc011ec7],
  [false, 3, 0x5eed123],
  [true, 1, 0x1a2b3c],
] as const)(
  "replays bounded collection geometry and retired input (axis=%s columns=%s seed=%s)",
  async (horizontal, columns, seed) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture(horizontal, columns),
      random = generator(seed),
      trace: unknown[] = [];
    try {
      await f.render();
      f.check();
      for (let step = 0; step < 64; step++) {
        const action = random() % 8;
        if (action === 0) {
          const row = random() % Math.ceil(f.state.data.length / columns),
            position = [0, 0.5, 1][random() % 3],
            inset = random() % 4;
          trace.push({ action: "index", row, position, inset });
          await f.index(row, position, inset);
        } else if (action === 1) {
          const offset = random() % Math.ceil(f.maximum() + 30);
          trace.push({ action: "offset", offset });
          f.state.offset = Math.min(offset, f.maximum());
          f.list.current!.scrollToOffset({ offset, animated: false });
          await settle(f.root);
        } else if (action === 2) {
          trace.push({ action: "end" });
          f.state.offset = f.maximum();
          f.list.current!.scrollToEnd({ animated: false });
          await settle(f.root);
        } else if (action === 3) {
          f.state.viewport = [40, 60, 80, 100][random() % 4];
          trace.push({ action: "viewport", value: f.state.viewport });
          f.state.offset = Math.min(f.state.offset, f.maximum());
          await f.render();
        } else if (action === 4) {
          f.state.header = [0, 13, 27][random() % 3];
          f.state.footer = [0, 9, 19][random() % 3];
          trace.push({ action: "boundaries", header: f.state.header, footer: f.state.footer });
          f.state.offset = Math.min(f.state.offset, f.maximum());
          await f.render();
        } else if (action === 5) {
          f.state.leading = [0, 5, 11][random() % 3];
          f.state.trailing = [0, 7, 15][random() % 3];
          trace.push({ action: "insets", leading: f.state.leading, trailing: f.state.trailing });
          f.state.offset = Math.min(f.state.offset, f.maximum());
          await f.render();
        } else if (action === 6) {
          const operation = random() % 4;
          trace.push({ action: "data", operation });
          f.replace(operation);
          await f.render();
        } else {
          await f.index(0);
          const item = f.state.data[0],
            node = [...f.scene.nodes.values()].find(
              (entry) => entry.fields.id === "replay-" + item.id,
            )!;
          f.scene.emit(node, "focusedChild", "replay-" + item.id);
          f.input.dispatch({ key: "select", phase: "down" });
          const count = f.activations.length;
          f.state.data = f.state.data.slice(1);
          f.state.offset = Math.min(f.state.offset, f.maximum());
          await f.render();
          f.state.data = [item, ...f.state.data];
          await f.render();
          f.input.dispatch({ key: "select", phase: "up" });
          expect(f.activations).toHaveLength(count);
          trace.push({ action: "retire-return-held", id: item.id });
        }
        f.check();
      }
    } catch (error) {
      throw Error(
        `Collection replay seed=${seed} axis=${horizontal ? "x" : "y"} columns=${columns} trace=${JSON.stringify(trace)}`,
        { cause: error },
      );
    } finally {
      f.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);
