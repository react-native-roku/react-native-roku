import { createElement, createRef, type ElementRef } from "react";
import { createNativeRoot } from "react-native-roku";
import { FlatList, View, type ViewabilityInfo } from "react-native";
import { RecordingSceneGraph } from "react-native-roku/testing";

/** Public packed-consumer coverage for row expansion and delayed owner retirement. */
export async function qualifyCollectionViewability() {
  const results = [];
  for (const [horizontal, columns, declared] of [
    [false, 1, true],
    [false, 3, true],
    [true, 1, false],
  ] as const) {
    const scene = new RecordingSceneGraph(),
      ref = createRef<ElementRef<typeof FlatList<{ id: string }>>>(),
      events: { owner: string; info: ViewabilityInfo<{ id: string }> }[] = [];
    let data = Array.from({ length: 30001 }, (_, index) => ({ id: String(index) })),
      callbackOwner = "initial",
      renders = 0;
    const root = createNativeRoot(scene, {
      strictMode: true,
      viewport: { width: 400, height: 200 },
      text: { prepare() {}, metrics: () => ({ lineHeight: 20, width: () => 8 }) },
    });
    const demand = (condition: unknown, message: string) => {
      if (!condition) throw Error("Packed viewability: " + message);
    };
    const settle = async () => {
      for (let index = 0; index < 6; index++) {
        await root.whenCommitted();
        root.flush();
      }
    };
    const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 30));
    const render = async () => {
      const owner = callbackOwner;
      root.render(
        createElement(FlatList<{ id: string }>, {
          ref,
          data,
          horizontal,
          numColumns: columns,
          keyExtractor: (item) => item.id,
          getItemLayout: declared
            ? (_data, index) => ({ length: 20, offset: index * 20 })
            : undefined,
          initialNumToRender: 3,
          maxToRenderPerBatch: 1,
          updateCellsBatchingPeriod: 60000,
          windowSize: 3,
          showsHorizontalScrollIndicator: false,
          showsVerticalScrollIndicator: false,
          viewabilityConfig: {
            itemVisiblePercentThreshold: 1,
            minimumViewTime: 20,
            waitForInteraction: true,
          },
          onViewableItemsChanged: (info) => events.push({ owner, info }),
          style: horizontal
            ? { width: 50, height: 40, flexGrow: 0, flexShrink: 0 }
            : { width: 400, height: 50, flexGrow: 0, flexShrink: 0 },
          renderItem: () => {
            renders++;
            return createElement(View, {
              style: horizontal ? { width: 20, height: 20 } : { height: 20, width: 80 },
            });
          },
        }),
      );
      await settle();
    };
    const keys = () => events.at(-1)?.info.viewableItems.map((token) => token.key);
    let retiredCount = 0;
    try {
      await render();
      ref.current!.scrollToOffset({ offset: 20, animated: false });
      await settle();
      await wait();
      demand(events.length === 0, "programmatic scrolling must not invent interaction");
      ref.current!.recordInteraction();
      await settle();
      callbackOwner = "current";
      await render();
      await wait();
      const expected = Array.from({ length: 3 * columns }, (_, index) => String(columns + index));
      demand(
        JSON.stringify(keys()) === JSON.stringify(expected),
        "original item tokens from visible rows",
      );
      demand(
        events.every((event) => event.owner === "current"),
        "pending callback must use the current callback owner",
      );
      for (const token of events.at(-1)!.info.viewableItems) {
        demand(
          token.item === data[token.index] && token.isViewable && token.key === token.item.id,
          "original item/index/key identity",
        );
      }
      ref.current!.scrollToOffset({ offset: 60, animated: false });
      await settle();
      data = data.map((item) => ({ id: "new-" + item.id }));
      await render();
      if (!declared) {
        // The pinned helper requires a known first-cell metric after key replacement.
        ref.current!.scrollToOffset({ offset: 0, animated: false });
        await settle();
        ref.current!.scrollToOffset({ offset: 60, animated: false });
        await settle();
      }
      await wait();
      const replaced = Array.from(
        { length: 3 * columns },
        (_, index) => "new-" + (3 * columns + index),
      );
      demand(
        JSON.stringify(keys()) === JSON.stringify(replaced),
        "replacement generation must own all delayed tokens",
      );
      demand(renders < 200, "large collection work must remain windowed");
      ref.current!.scrollToOffset({ offset: 120, animated: false });
      await settle();
      const stale = ref.current!;
      retiredCount = events.length;
      root.unmount();
      stale.recordInteraction();
      await wait();
      demand(events.length === retiredCount, "retired list must not deliver pending callbacks");
      demand(scene.nodes.size === 1 && scene.listenerCount === 0, "list resources must retire");
      results.push({
        horizontal,
        columns,
        declared,
        items: data.length,
        renders,
        callbacks: events.length,
        keys: replaced,
        retired: true,
      });
    } finally {
      root.unmount();
    }
  }
  return results;
}
