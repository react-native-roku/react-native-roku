import { useEffect, useRef, useState, type ElementRef } from "react";
import { BackHandler, FlatList, Image, Pressable, Text, View } from "react-native";
import cover from "./catalog-cover.png";
import { narrow, reveal, routes, rowHeight, wide, windowHeight, type Route } from "./holdout";

export default function Holdout() {
  const [items, setItems] = useState(routes);
  const [active, setActive] = useState(routes[0].id);
  const [detail, setDetail] = useState(false);
  const [compact, setCompact] = useState(false);
  const list = useRef<ElementRef<typeof FlatList<Route>>>(null);
  const offset = useRef(0);
  const restore = useRef(routes[0].id);
  const index = items.findIndex((item) => item.id === active);
  useEffect(() => {
    if (!detail) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      setDetail(false);
      return true;
    });
    return () => sub.remove();
  }, [detail]);
  if (detail)
    return (
      <View style={{ width: 1040, height: 720 }}>
        <Text nativeID="holdout-title" style={{ width: compact ? narrow : wide, fontSize: 28 }}>
          {items[index].title}
        </Text>
        <Pressable
          nativeID="holdout-resize"
          hasTVPreferredFocus
          onPress={() => setCompact(!compact)}
          style={{ width: 220, height: 72 }}
        >
          <Text>Change width</Text>
        </Pressable>
        <Pressable
          nativeID="holdout-remove"
          onPress={() => {
            restore.current = (items[index + 1] ?? items[index - 1]).id;
            setActive(restore.current);
            setItems(items.filter((item) => item.id !== active));
            setDetail(false);
          }}
          disabled={items.length < 2}
          style={{ width: 220, height: 72 }}
        >
          <Text>Remove route</Text>
        </Pressable>
      </View>
    );
  return (
    <FlatList
      ref={list}
      nativeID="holdout-window"
      data={items}
      style={{ width: wide, height: windowHeight, flexGrow: 0 }}
      initialScrollIndex={items.findIndex((item) => item.id === restore.current)}
      initialNumToRender={5}
      windowSize={3}
      keyExtractor={(item) => item.id}
      getItemLayout={(_, i) => ({ index: i, length: rowHeight, offset: i * rowHeight })}
      onLayout={() => list.current?.scrollToOffset({ offset: offset.current, animated: false })}
      renderItem={({ item, index: i }) => (
        <Pressable
          nativeID={item.id}
          hasTVPreferredFocus={item.id === restore.current}
          style={({ focused }) => ({
            width: wide,
            height: rowHeight,
            flexDirection: "row",
            backgroundColor: focused ? "#3456c0" : "#303040",
          })}
          onFocus={() => {
            setActive(item.id);
            const next = reveal(i, offset.current);
            if (next !== offset.current) {
              offset.current = next;
              list.current?.scrollToOffset({ offset: next, animated: false });
            }
          }}
          onPress={() => {
            restore.current = item.id;
            setActive(item.id);
            setCompact(false);
            setDetail(true);
          }}
        >
          <Image source={cover} style={{ width: 96, height: rowHeight }} />
          <Text style={{ width: 600, fontSize: 26 }}>{item.title}</Text>
        </Pressable>
      )}
    />
  );
}
