import { useLayoutEffect, useRef, type ElementRef } from "react";
import { FlatList, View, type NativeViewHandle } from "react-native";

const data = Array.from({ length: 17 }, (_, index) => ({
  id: String(index),
  width: [60, 80, 100][index % 3],
}));
const offsets = data.map((_item, index) => Math.floor(index / 3) * 240 + [0, 60, 140][index % 3]);
/** Visible, bounded single-axis fixture shared by packed SDK and Canvas lanes. */
export function HorizontalFixture() {
  const list = useRef<ElementRef<typeof FlatList<(typeof data)[number]>>>(null),
    handles = useRef(new Map<string, NativeViewHandle>());
  useLayoutEffect(() => {
    const api = {
      end: () => list.current!.scrollToEnd({ animated: false }),
      start: () => list.current!.scrollToOffset({ offset: 0, animated: false }),
      snapshot() {
        const rectangles: { id: string; x: number; y: number; width: number; height: number }[] =
          [];
        for (const [id, handle] of handles.current)
          handle.measureInWindow((x, y, width, height) =>
            rectangles.push({ id, x, y, width, height }),
          );
        return rectangles;
      },
    };
    const target = globalThis as unknown as { __RNR_HORIZONTAL_FIXTURE__?: typeof api };
    target.__RNR_HORIZONTAL_FIXTURE__ = api;
    return () => {
      if (target.__RNR_HORIZONTAL_FIXTURE__ === api) delete target.__RNR_HORIZONTAL_FIXTURE__;
    };
  }, []);
  return (
    <FlatList<(typeof data)[number]>
      ref={list}
      data={data}
      horizontal
      nativeID="fixture-horizontal"
      keyExtractor={(item) => item.id}
      initialNumToRender={2}
      maxToRenderPerBatch={1}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingLeft: 5, paddingRight: 7 }}
      ListHeaderComponent={<View style={{ width: 20, height: 40 }} />}
      ListHeaderComponentStyle={{
        width: 32,
        height: 40,
        paddingLeft: 6,
        marginLeft: 5,
        marginRight: 7,
        backgroundColor: "#663399",
      }}
      ListFooterComponent={
        <View
          style={{ width: 17, height: 40 }}
          ref={(handle) => {
            if (handle) handles.current.set("footer", handle);
            else handles.current.delete("footer");
          }}
        />
      }
      ListFooterComponentStyle={{
        width: 29,
        height: 40,
        paddingLeft: 4,
        backgroundColor: "#227788",
      }}
      getItemLayout={(_items, index) => ({
        index,
        length: data[index].width,
        offset: offsets[index],
      })}
      style={{
        position: "absolute",
        left: 1000,
        top: 460,
        width: 340,
        height: 60,
        flexGrow: 0,
        flexShrink: 0,
      }}
      renderItem={({ item }) => (
        <View
          nativeID={"fixture-horizontal-" + item.id}
          ref={(handle) => {
            if (handle) handles.current.set(item.id, handle);
            else handles.current.delete(item.id);
          }}
          style={{ width: item.width, height: 40, backgroundColor: "#446622" }}
        />
      )}
    />
  );
}
