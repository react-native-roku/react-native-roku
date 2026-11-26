import { createElement, createRef, type ElementRef } from "react";
import { createNativeRoot } from "react-native-roku";
import { FlatList, View, type NativeViewHandle } from "react-native";
import { RecordingSceneGraph } from "react-native-roku/testing";

/** Minimized public-consumer counterexamples from the fixed-seed collection replay. */
export async function qualifyCollectionGeometryLifetimes() {
  const results = [];
  for (const [horizontal, columns] of [
    [false, 1],
    [false, 2],
    [false, 3],
    [true, 1],
  ] as const) {
    const scene = new RecordingSceneGraph(),
      ref = createRef<ElementRef<typeof FlatList<{ id: string }>>>(),
      handles = new Map<string, NativeViewHandle>();
    let data = Array.from({ length: 101 }, (_, index) => ({ id: String(index) })),
      header = 13,
      anchored = false;
    const root = createNativeRoot(scene, {
      strictMode: true,
      viewport: { width: 400, height: 200 },
      text: {
        prepare() {},
        metrics: () => ({ lineHeight: 20, width: () => 8 }),
      },
    });
    const demand = (condition: unknown, message: string) => {
      if (!condition) throw Error("Packed collection geometry: " + message);
    };
    const settle = async () => {
      for (let index = 0; index < 6; index++) {
        await root.whenCommitted();
        root.flush();
      }
    };
    const size = (length: number) =>
      horizontal ? { width: length, height: 20 } : { height: length, width: 80 };
    const render = async () => {
      root.render(
        createElement(FlatList<{ id: string }>, {
          ref,
          data,
          horizontal,
          numColumns: columns,
          keyExtractor: (item) => item.id,
          columnWrapperStyle: columns > 1 ? { columnGap: 4 } : undefined,
          getItemLayout: (original, index) => {
            demand(original === data, "declared layout must retain original data");
            return { index, length: 20, offset: index * 24 };
          },
          maintainVisibleContentPosition: anchored ? { minIndexForVisible: 0 } : undefined,
          renderItem: ({ item }) =>
            createElement(View, {
              nativeID: "geometry-" + item.id,
              style: horizontal ? { width: 20, height: 20 } : { width: 80, height: 20 },
              ref: (handle) => {
                if (handle) handles.set(item.id, handle);
                else handles.delete(item.id);
              },
            }),
          ItemSeparatorComponent: () => createElement(View, { style: size(4) }),
          ListHeaderComponent: header ? createElement(View, { style: size(header) }) : null,
          ListFooterComponent: createElement(View, { style: size(17) }),
          contentContainerStyle: horizontal
            ? { paddingLeft: 5, paddingRight: 7 }
            : { paddingTop: 5, paddingBottom: 7 },
          style: horizontal
            ? { width: 60, height: 40, flexGrow: 0, flexShrink: 0 }
            : { width: 400, height: 60, flexGrow: 0, flexShrink: 0 },
          initialNumToRender: 1,
          maxToRenderPerBatch: 1,
          windowSize: 3,
          updateCellsBatchingPeriod: 60000,
          showsHorizontalScrollIndicator: false,
          showsVerticalScrollIndicator: false,
        }),
      );
      await settle();
    };
    const position = (id: string) => {
      let value: number | undefined;
      handles.get(id)?.measureInWindow((x, y) => {
        value = horizontal ? x : y;
      });
      return value;
    };
    let tailAfterPrepend: number | undefined;
    try {
      await render();
      ref.current!.scrollToIndex({ index: 10, viewPosition: 0.5, animated: false });
      await settle();
      demand(
        position(String(10 * columns)) === 20,
        "alignment must use the declared item length rather than separator stride",
      );
      header = 0;
      await render();
      ref.current!.scrollToIndex({ index: 10, animated: false });
      await settle();
      demand(
        position(String(10 * columns)) === 0,
        "a removed header must not contribute stale geometry",
      );
      ref.current!.scrollToEnd({ animated: false });
      await settle();
      ref.current!.scrollToEnd({ animated: false });
      await settle();
      const lastRow = Math.ceil(data.length / columns) - 1;
      for (const command of ["index", "index", "offset", "offset"]) {
        if (command === "index") ref.current!.scrollToIndex({ index: lastRow, animated: false });
        else ref.current!.scrollToOffset({ offset: 1_000_000, animated: false });
        await settle();
        demand(
          position(String((lastRow - 1) * columns)) === -8,
          "repeated clamped commands must preserve the still-visible preceding row",
        );
      }
      data = [{ id: "prepend" }, ...data];
      await render();
      tailAfterPrepend = position("100");
      demand(
        tailAfterPrepend === (columns === 1 ? 40 : 16),
        "repeated End must retain the actual footer/inset offset across a prepend",
      );
      anchored = true;
      await render();
      ref.current!.scrollToEnd({ animated: false });
      await settle();
      const anchorRow = Math.ceil(data.length / columns) - 2,
        anchorID = data[anchorRow * columns].id,
        anchorOwner = handles.get(anchorID),
        anchorPosition = position(anchorID);
      data = [
        ...Array.from({ length: 40 * columns }, (_, index) => ({ id: "large-prepend-" + index })),
        ...data,
      ];
      await render();
      demand(
        handles.get(anchorID) === anchorOwner && position(anchorID) === anchorPosition,
        "arriving anchor geometry must retain the original mounted owner while native extent grows",
      );
      demand(handles.size < 32 * columns, "window work must remain bounded");
    } finally {
      root.unmount();
    }
    demand(
      scene.nodes.size === 1 && scene.listenerCount === 0 && handles.size === 0,
      "all collection resources must retire",
    );
    results.push({
      horizontal,
      columns,
      declaredAlignment: true,
      headerRetirement: true,
      repeatedEnd: true,
      repeatedClamps: true,
      largePrependAnchor: true,
      tailAfterPrepend,
      cleanup: true,
    });
  }
  const delayedStarts = [];
  for (const horizontal of [false, true])
    for (const header of [0, 13]) {
      const scene = new RecordingSceneGraph(),
        handles = new Map<string, NativeViewHandle>();
      const root = createNativeRoot(scene, {
        viewport: { width: 400, height: 200 },
        text: { prepare() {}, metrics: () => ({ lineHeight: 20, width: () => 8 }) },
      });
      const data = Array.from({ length: 41 }, (_, index) => String(index));
      let observedOffset = 0;
      const settle = async () => {
        for (let index = 0; index < 6; index++) {
          await root.whenCommitted();
          root.flush();
        }
      };
      const render = (populated: boolean) =>
        root.render(
          createElement(FlatList<string>, {
            data: populated ? data : [],
            horizontal,
            initialScrollIndex: 10,
            keyExtractor: (item) => item,
            getItemLayout: (_data, index) => ({ index, length: 20, offset: index * 24 }),
            renderItem: ({ item }) =>
              createElement(View, {
                style: { width: 20, height: 20 },
                ref: (handle) => {
                  if (handle) handles.set(item, handle);
                  else handles.delete(item);
                },
              }),
            ItemSeparatorComponent: () =>
              createElement(View, { style: horizontal ? { width: 4, height: 20 } : { height: 4 } }),
            ListHeaderComponent:
              populated && header
                ? createElement(View, {
                    style: horizontal ? { width: header, height: 20 } : { height: header },
                  })
                : null,
            contentContainerStyle: horizontal ? { paddingLeft: 5 } : { paddingTop: 5 },
            style: horizontal
              ? { width: 60, height: 40, flexGrow: 0, flexShrink: 0 }
              : { width: 400, height: 60, flexGrow: 0, flexShrink: 0 },
            showsHorizontalScrollIndicator: false,
            showsVerticalScrollIndicator: false,
            onScroll: (event) => {
              observedOffset = event.nativeEvent.contentOffset[horizontal ? "x" : "y"];
            },
          }),
        );
      try {
        render(false);
        await settle();
        render(true);
        await settle();
        let position: number | undefined;
        handles.get("10")?.measureInWindow((x, y) => {
          position = horizontal ? x : y;
        });
        if (position !== 0 || observedOffset !== header + 245)
          throw Error("Packed initial jump did not wait for committed data/header extent");
      } finally {
        root.unmount();
      }
      if (scene.nodes.size !== 1 || scene.listenerCount !== 0 || handles.size !== 0)
        throw Error("Packed delayed initial jump did not retire");
      delayedStarts.push({ horizontal, header, offset: observedOffset, cleanup: true });
    }
  return { geometries: results, delayedStarts };
}
