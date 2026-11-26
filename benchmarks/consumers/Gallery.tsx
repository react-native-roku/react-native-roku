import { useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import cover from "./catalog-cover.png";

export default function Gallery() {
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState("pending");
  const step = index % 3;
  return (
    <View style={{ width: 1920, height: 1080, padding: 60 }}>
      <Pressable
        nativeID="gallery-next"
        hasTVPreferredFocus
        onPress={() => {
          setStatus("pending");
          setIndex((i) => i + 1);
        }}
      >
        <Text>Change image</Text>
      </Pressable>
      <Text nativeID="gallery-step">
        {["Packaged image", "Missing image", "Unmounted image"][step]}
      </Text>
      {step !== 2 && (
        <Image
          key={index}
          source={step === 0 ? cover : { uri: "pkg:/images/absent-fixture.png" }}
          onLoad={() => setStatus("loaded")}
          onError={() => setStatus("failed")}
          style={{ width: 640, height: 320 }}
        />
      )}
      <Text nativeID="gallery-status">{step === 2 ? "removed" : status}</Text>
    </View>
  );
}
