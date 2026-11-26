import { useState } from "react";
import { Image, Modal, Pressable, ScrollView, Text, View } from "react-native";
import cover from "./catalog-cover.png";

export const viewport = { width: 360, height: 660 };
const font = { fontFamily: "Inter", fontSize: 19, lineHeight: 24, color: "#f5f3ed" };
const title = "Long intrinsic mountain title with several words that wrap past the first line";
const readLayout = (id: string) => (event: unknown) => {
  const { layout } = (event as { nativeEvent: { layout: object } }).nativeEvent;
  console.log("RNR_PARITY_LAYOUT", JSON.stringify({ id, layout }));
};
const button = {
  width: 160,
  height: 46,
  padding: 7,
  backgroundColor: "#405070",
};

export default function Parity() {
  const [changed, setChanged] = useState(false);
  const [modal, setModal] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <View
      nativeID="parity-viewport"
      onLayout={readLayout("viewport")}
      style={{ ...viewport, padding: 14, backgroundColor: "#151920" }}
    >
      <Text nativeID="parity-title" onLayout={readLayout("title")} style={{ ...font, width: 240 }}>
        {changed ? title + " once again after the edit" : title}
      </Text>
      <Text
        nativeID="parity-truncated"
        onLayout={readLayout("truncated")}
        numberOfLines={1}
        style={{ ...font, width: 205, textAlign: "center" }}
      >
        {title}
      </Text>
      <View style={{ flexDirection: "row", marginVertical: 12 }}>
        <View
          nativeID="parity-clip"
          onLayout={readLayout("clip")}
          style={{
            width: 156,
            height: 128,
            backgroundColor: "#32604d",
            overflow: "hidden",
            borderRadius: 20,
          }}
        >
          <Image
            nativeID="parity-image"
            source={cover}
            resizeMode="cover"
            style={{ width: 176, height: 112, marginLeft: -12, opacity: changed ? 1 : 0.7 }}
          />
          <View
            nativeID="parity-layer-top"
            style={{
              position: "absolute",
              left: 74,
              top: 46,
              width: 62,
              height: 54,
              zIndex: 2,
              backgroundColor: "#e28353",
              transform: [{ rotate: changed ? "-14deg" : "14deg" }],
            }}
          />
          <View
            nativeID="parity-layer-under"
            style={{
              position: "absolute",
              left: 45,
              top: 58,
              width: 70,
              height: 60,
              zIndex: 1,
              backgroundColor: "#5179bf",
            }}
          />
        </View>
        <View
          nativeID="parity-alignment"
          onLayout={readLayout("aligned")}
          style={{ flex: 1, height: 128, alignItems: "center", justifyContent: "center" }}
        >
          <Text style={font}>Centered</Text>
        </View>
      </View>
      <ScrollView
        nativeID="parity-scroll"
        onLayout={readLayout("scroll")}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ width: 332, height: 90, flexGrow: 0, backgroundColor: "#202939" }}
      >
        {Array.from({ length: 7 }, (_, index) => (
          <View
            key={index}
            style={{ width: 90, height: 86, marginRight: 8, backgroundColor: "#395779" }}
          >
            <Text style={font}>Route {index + 1}</Text>
          </View>
        ))}
      </ScrollView>
      <View style={{ flexDirection: "row", marginTop: 12 }}>
        <Pressable
          nativeID="parity-change"
          accessibilityRole="button"
          accessibilityState={{ selected: changed }}
          hasTVPreferredFocus
          onPress={() => setChanged((value) => !value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            ...button,
            marginRight: 8,
            backgroundColor: focused ? "#688ad4" : button.backgroundColor,
          }}
        >
          <Text style={font}>{changed ? "Restore scene" : "Change scene"}</Text>
        </Pressable>
        <Pressable
          nativeID="parity-modal-open"
          accessibilityRole="button"
          onPress={() => setModal(true)}
          style={button}
        >
          <Text style={font}>Open modal</Text>
        </Pressable>
      </View>
      <Modal visible={modal} transparent onRequestClose={() => setModal(false)}>
        <View
          nativeID="parity-dialog"
          accessibilityViewIsModal
          style={{ width: 264, height: 152, margin: 36, padding: 16, backgroundColor: "#2e3549" }}
        >
          <Text style={font}>Route information</Text>
          <Pressable
            nativeID="parity-modal-close"
            accessibilityRole="button"
            hasTVPreferredFocus
            onPress={() => setModal(false)}
            style={button}
          >
            <Text style={font}>Dismiss</Text>
          </Pressable>
        </View>
      </Modal>
    </View>
  );
}
