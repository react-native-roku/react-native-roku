import { useState } from "react";
import { View, Text, Pressable } from "react-native";
export default function App() {
  const [count, setCount] = useState(0);
  return (
    <View
      style={{
        width: 1920,
        height: 1080,
        padding: 100,
        backgroundColor: "#101014",
      }}
    >
      <Text style={{ fontSize: 44, color: "white" }}>Hello, Roku</Text>
      <Text style={{ fontSize: 32, fontWeight: "bold", color: "white" }}>Weighted 700</Text>
      <Text
        style={{ fontSize: 32, fontFamily: "InterRegular", fontStyle: "italic", color: "white" }}
      >
        Italic 400
      </Text>
      <Text
        style={{
          fontSize: 32,
          fontFamily: "InterBoldItalic",
          fontWeight: "400",
          fontStyle: "italic",
          color: "white",
        }}
      >
        Physical italic 700
      </Text>
      <Text
        nativeID="tabular-digits"
        style={{ fontSize: 32, color: "white", fontVariant: ["tabular-nums"] }}
      >
        0123456789
      </Text>
      <Pressable
        nativeID="counter"
        hasTVPreferredFocus
        onPress={() => setCount((value) => value + 1)}
        style={({ focused }) => ({
          width: 600,
          height: 100,
          marginTop: 30,
          padding: 20,
          backgroundColor: focused ? "#3456c0" : "#303040",
        })}
      >
        <Text style={{ fontSize: 32, color: "white" }}>Pressed {count} times</Text>
      </Pressable>
    </View>
  );
}
