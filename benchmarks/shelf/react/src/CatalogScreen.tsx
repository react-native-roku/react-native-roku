import { useEffect, useRef, useState, type ElementRef } from "react";
import { BackHandler, Pressable, ScrollView, Text, View } from "react-native";
import {
  catalogHeight,
  catalogLeft,
  catalogTitle,
  catalogTop,
  catalogWidth,
  cardLeft,
  cardTop,
  contentHeight,
  detailTitle,
  scrollFor,
  cardColor,
  cardFontSize,
  cardHeight,
  cardLabelHeight,
  cardWidth,
  focusColor,
  tiles,
  titleColor,
  titleFontSize,
  titleFrame,
  viewport,
} from "./shelf";

export default function Catalog() {
  const [active, setActive] = useState(0);
  const [detail, setDetail] = useState<number | null>(null);
  const scroll = useRef<ElementRef<typeof ScrollView>>(null);
  const cards = useRef<Array<ElementRef<typeof Pressable> | null>>([]);
  const close = useRef<ElementRef<typeof Pressable>>(null);
  const restore = useRef(0);
  const offset = useRef(0);

  useEffect(() => {
    if (detail == null) cards.current[restore.current]?.focus();
    else close.current?.focus();
  }, [detail]);
  useEffect(() => {
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      if (detail == null) return false;
      setDetail(null);
      return true;
    });
    return () => back.remove();
  }, [detail]);

  return (
    <View style={viewport}>
      <View
        style={{ position: "absolute", ...titleFrame }}
        importantForAccessibility="no-hide-descendants"
      >
        <Text
          nativeID="selection"
          style={{ width: titleFrame.width, fontSize: titleFontSize, color: titleColor }}
        >
          {catalogTitle(active)}
        </Text>
      </View>
      <ScrollView
        ref={scroll}
        nativeID="catalog-window"
        showsVerticalScrollIndicator={false}
        style={{
          position: "absolute",
          left: catalogLeft,
          top: catalogTop,
          width: catalogWidth,
          height: catalogHeight,
        }}
        contentContainerStyle={{ width: catalogWidth, height: contentHeight }}
      >
        <View nativeID="catalog-content" style={{ width: catalogWidth, height: contentHeight }}>
          {tiles.map(({ index, id, title }) => (
            <Pressable
              key={id}
              ref={(node) => {
                cards.current[index] = node;
              }}
              nativeID={id}
              accessibilityRole="button"
              accessibilityLabel={title}
              onFocus={() => {
                setActive(index);
                const next = scrollFor(index, offset.current);
                if (next !== offset.current) {
                  offset.current = next;
                  scroll.current?.scrollTo({ y: next });
                }
              }}
              onPress={() => {
                restore.current = index;
                setDetail(index);
              }}
              style={({ focused }) => ({
                position: "absolute",
                left: cardLeft(index),
                top: cardTop(index),
                width: cardWidth,
                height: cardHeight,
                backgroundColor: focused ? focusColor : cardColor,
              })}
            >
              <Text
                style={{
                  width: cardWidth,
                  height: cardLabelHeight,
                  fontSize: cardFontSize,
                  color: titleColor,
                }}
              >
                {title}
              </Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
      {detail != null && (
        <View aria-modal style={{ position: "absolute", ...viewport, backgroundColor: "#101014" }}>
          <Text
            nativeID="details"
            style={{
              position: "absolute",
              left: titleFrame.left,
              top: titleFrame.top,
              width: titleFrame.width,
              height: titleFrame.height,
              fontSize: titleFontSize,
              color: titleColor,
            }}
          >
            {detailTitle(detail)}
          </Text>
          <Pressable
            ref={close}
            nativeID="back-to-catalog"
            accessibilityRole="button"
            accessibilityLabel="Back to catalog"
            onPress={() => setDetail(null)}
            style={{
              position: "absolute",
              left: catalogLeft,
              top: catalogTop,
              width: cardWidth,
              height: cardHeight,
              backgroundColor: focusColor,
            }}
          >
            <Text
              style={{
                width: cardWidth,
                height: cardLabelHeight,
                fontSize: cardFontSize,
                color: titleColor,
              }}
            >
              Back
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
