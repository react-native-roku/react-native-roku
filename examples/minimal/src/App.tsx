import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { Svg, Rect } from "react-native-svg";
export function App() {
  const [count, setCount] = useState(0);
  return (
    <View style={{ width: 640, height: 360, padding: 20 }}>
      <Text style={{ fontSize: 20 }}>Independent Roku consumer</Text>
      <Pressable
        nativeID="increment"
        onPress={() => setCount((value) => value + 1)}
        style={{ width: 180, height: 50 }}
      >
        <Text>Count {count}</Text>
      </Pressable>
      <Svg width={24} height={24} viewBox="0 0 24 24">
        <Rect width={24} height={24} fill="#00ff00" />
      </Svg>
    </View>
  );
}
