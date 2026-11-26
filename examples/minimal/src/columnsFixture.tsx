import { useLayoutEffect, useRef, type ComponentProps } from "react";
import { FlatList, View, Text, type NativeViewHandle, type ViewToken } from "react-native";

const data = Array.from({ length: 7 }, (_, index) => String(index));
/** Small public-import fixture shared by the packed SDK and Canvas lanes. */
export function ColumnsFixture() {
  const handles = useRef(new Map<string, NativeViewHandle>());
  const controls = useRef(
    new Map<
      string,
      Parameters<ComponentProps<typeof FlatList<string>>["renderItem"]>[0]["separators"]
    >(),
  );
  const viewable = useRef<ViewToken<string>[]>([]);
  const separatorHandles = useRef(new Map<string, NativeViewHandle>());
  useLayoutEffect(() => {
    const api = {
      viewability: () =>
        viewable.current.map(({ item, key, index, isViewable }) => ({
          item,
          key,
          index,
          isViewable,
        })),
      highlight: (id: string) => controls.current.get(id)!.highlight(),
      unhighlight: (id: string) => controls.current.get(id)!.unhighlight(),
      separatorSnapshot() {
        const rectangles: { id: string; x: number; y: number; width: number; height: number }[] =
          [];
        for (const [id, handle] of separatorHandles.current)
          handle.measureInWindow((x, y, width, height) =>
            rectangles.push({ id, x, y, width, height }),
          );
        return rectangles.sort((left, right) => Number(left.id) - Number(right.id));
      },
      snapshot() {
        const rectangles: { id: string; x: number; y: number; width: number; height: number }[] =
          [];
        for (const [id, handle] of handles.current)
          handle.measureInWindow((x, y, width, height) =>
            rectangles.push({ id, x, y, width, height }),
          );
        return rectangles.sort((left, right) => Number(left.id) - Number(right.id));
      },
    };
    const target = globalThis as unknown as { __RNR_COLUMNS_FIXTURE__?: typeof api };
    target.__RNR_COLUMNS_FIXTURE__ = api;
    return () => {
      if (target.__RNR_COLUMNS_FIXTURE__ === api) delete target.__RNR_COLUMNS_FIXTURE__;
    };
  }, []);
  return (
    <FlatList<string>
      data={data}
      onViewableItemsChanged={({ viewableItems }) => {
        viewable.current = viewableItems;
      }}
      numColumns={3}
      nativeID="fixture-columns"
      keyExtractor={(item) => item}
      initialNumToRender={1}
      maxToRenderPerBatch={1}
      columnWrapperStyle={{ columnGap: 8 }}
      ItemSeparatorComponent={({
        highlighted,
        leadingItem,
      }: {
        highlighted: boolean;
        leadingItem: readonly string[];
      }) => (
        <View
          ref={(handle) => {
            const id = leadingItem[0];
            if (handle) separatorHandles.current.set(id, handle);
            else separatorHandles.current.delete(id);
          }}
          style={{ height: 4, backgroundColor: highlighted ? "#993311" : "transparent" }}
        />
      )}
      getItemLayout={(_data, index) => ({ index, length: 40, offset: 44 * index })}
      style={{
        position: "absolute",
        left: 1000,
        top: 300,
        width: 340,
        height: 132,
        flexGrow: 0,
        flexShrink: 0,
      }}
      renderItem={({ item, separators }) => {
        controls.current.set(item, separators);
        return (
          <View
            nativeID={"fixture-column-" + item}
            ref={(handle) => {
              if (handle) handles.current.set(item, handle);
              else handles.current.delete(item);
            }}
            style={{ width: 100, height: 40, backgroundColor: "#224466" }}
          >
            <Text style={{ color: "white", fontSize: 20 }}>{"Column " + item}</Text>
          </View>
        );
      }}
    />
  );
}
