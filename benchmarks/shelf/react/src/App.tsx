import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ElementRef } from "react";
import Catalog from "./CatalogScreen";
import { activation, catalog, marks } from "./shelfMode";
import { mark } from "./shelfTrace";
import {
  cardColor,
  cardFontSize,
  cardHeight,
  cardLabelHeight,
  cardWidth,
  focusColor,
  tiles,
  title,
  titleColor,
  titleFontSize,
  titleFrame,
  viewport,
} from "./shelf";

type TitleWorkload = "changing" | "static" | "intrinsic";

function Shelf({ titleWorkload = "changing" }: { titleWorkload?: TitleWorkload }) {
  const first = useRef<ElementRef<typeof Pressable>>(null);
  const [active, setActive] = useState(0);
  const [stress, setStress] = useState(false);
  const [press, setPress] = useState<{ id: string; count: number }>();
  const titleFor = (index: number) => {
    const selected =
      titleWorkload === "static"
        ? title(0)
        : titleWorkload === "intrinsic" && index !== 0
          ? `${title(index)} ${"with a substantially longer selected title ".repeat(5).trim()}`
          : title(index);
    return press ? `${selected} | Press ${press.id} #${press.count}` : selected;
  };
  const selectedTitle = titleFor(active);
  useEffect(() => first.current?.focus(), []);
  if (marks) mark("react.render", { active: tiles[active].id });
  return (
    <View style={viewport}>
      <View
        pointerEvents="none"
        importantForAccessibility="no-hide-descendants"
        style={{ position: "absolute", ...titleFrame }}
      >
        <Text
          nativeID="selection"
          style={{
            width: titleFrame.width,
            ...(titleWorkload === "intrinsic" ? {} : { height: titleFrame.height }),
            fontSize: titleFontSize,
            color: titleColor,
            ...(stress
              ? {
                  letterSpacing: 1.5,
                  textShadowColor: "rgba(0,0,0,0.7)",
                  textShadowRadius: 7,
                  textShadowOffset: { width: 1, height: 2 },
                }
              : {}),
          }}
        >
          {selectedTitle}
        </Text>
      </View>
      {tiles.map((tile) => (
        <Pressable
          key={tile.id}
          ref={tile.index === 0 ? first : undefined}
          nativeID={tile.id}
          unstable_tvFocusPresentation={{
            focusedColor: focusColor,
            restingColor: cardColor,
            label: { nativeID: "selection", text: titleFor(tile.index) },
          }}
          onFocus={() => {
            if (marks) mark("react.focus.callback", { target: tile.id });
            setActive(tile.index);
            console.log("SHELF_FOCUS", tile.id, performance.now());
          }}
          onPress={() => {
            if (activation) {
              if (marks) mark("press.handler", { target: tile.id });
              setPress((prior) => ({ id: tile.id, count: (prior?.count ?? 0) + 1 }));
            } else setStress((value) => !value);
          }}
          style={({ focused }) => ({
            position: "absolute",
            left: tile.x,
            top: tile.y,
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
            {tile.title}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

export default catalog ? Catalog : Shelf;
