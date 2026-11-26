import { useCallback, useEffect, useRef, useState, type ElementRef } from "react";
import { Image, Pressable, Text, View } from "react-native";

// 80×40 opaque PNG. Green and yellow edge bands must disappear when covered
// into the 64×64 poster. The inner red and blue halves remain visible.
const artwork =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFAAAAAoCAYAAABpYH0BAAAAY0lEQVR4nO3QMQ0AMAwEsYcT/sjCoFUhZIk6eDgA56RzJnXtlurV+j0OCkCAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQ4B+AFxhHTRZHCRx9AAAAAElFTkSuQmCC";
const source = { uri: artwork, width: 80, height: 40 };
const ignore = () => {};

export const coreUiStates = [
  { opacity: 0.5, width: 106 },
  { opacity: 0.25, width: 160 },
  { opacity: undefined, width: 106 },
] as const;

export function CoreUiFixture({
  left = 0,
  top = 0,
  onEvent = ignore,
  clipRadius = 18,
}: {
  left?: number;
  top?: number;
  onEvent?: (event: string) => void;
  clipRadius?: number;
}) {
  const [step, setStep] = useState(0);
  const [focused, setFocused] = useState(false);
  const state = coreUiStates[step];
  const imageLoaded = useCallback(() => {
    onEvent("image:load");
  }, [onEvent]);
  const next = useRef<ElementRef<typeof Pressable>>(null);
  useEffect(() => {
    next.current?.focus();
  }, []);
  useEffect(() => {
    onEvent("mount");
    return () => onEvent("unmount");
  }, [onEvent]);
  useEffect(() => {
    onEvent("commit:" + step);
  }, [onEvent, step]);

  return (
    <View
      nativeID="core-ui"
      style={{
        position: "absolute",
        left,
        top,
        width: 184,
        height: 160,
        backgroundColor: "#202020",
      }}
    >
      <View
        nativeID="core-wrap"
        style={{ width: state.width, flexDirection: "row", flexWrap: "wrap" }}
      >
        {["a", "b", "c"].map((key) => (
          <View
            key={key}
            nativeID={"core-cell-" + key}
            style={{ width: 52, height: 14, backgroundColor: "#809080" }}
          />
        ))}
      </View>
      <View
        nativeID="core-clip"
        style={{
          position: "absolute",
          left: 12,
          top: 40,
          width: 64,
          height: 64,
          borderRadius: clipRadius,
          overflow: "hidden",
        }}
      >
        <Image
          nativeID="core-art"
          source={source}
          resizeMode="cover"
          style={{ width: 64, height: 64 }}
          onLoad={imageLoaded}
        />
        <View
          nativeID="core-overlay-top"
          style={{
            position: "absolute",
            left: 18,
            top: 42,
            width: 28,
            height: 12,
            zIndex: 2,
            backgroundColor: "#ffffff",
          }}
        />
        <View
          nativeID="core-overlay-bottom"
          style={{
            position: "absolute",
            left: 16,
            top: 40,
            width: 32,
            height: 16,
            zIndex: 1,
            backgroundColor: "#008000",
          }}
        />
      </View>
      <View
        nativeID="core-alpha"
        style={{
          position: "absolute",
          left: 92,
          top: 40,
          width: 32,
          height: 32,
          backgroundColor: "#ffffff",
          opacity: state.opacity,
        }}
      />
      {focused && (
        <View
          pointerEvents="none"
          nativeID="core-outline"
          style={{
            position: "absolute",
            left: 8,
            top: 36,
            width: 72,
            height: 72,
            borderWidth: 2,
            borderColor: "#ffff00",
            borderRadius: 21,
          }}
        />
      )}
      <Pressable
        ref={next}
        nativeID="core-next"
        accessibilityRole="button"
        accessibilityLabel="Next fixture state"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onPress={() => {
          onEvent("press:" + step);
          setStep((step + 1) % coreUiStates.length);
        }}
        style={{
          position: "absolute",
          left: 12,
          top: 114,
          width: 152,
          height: 34,
          backgroundColor: "#303030",
        }}
      >
        <Text style={{ fontFamily: "Inter", fontSize: 32, lineHeight: 34 }} numberOfLines={1}>
          State {step} with a long title
        </Text>
      </Pressable>
    </View>
  );
}
