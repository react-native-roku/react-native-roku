import { useState } from "react";
import { Pressable, Text, View } from "react-native";

const titles = [
  "New routes",
  "On the coast",
  "Day trips",
  "For later",
  "High passes",
  "Trailheads",
];
const cards = Array.from({ length: 12 }, (_, index) => index + 1);

export default function Shelves() {
  const [focused, setFocused] = useState({ row: 0, number: 1 });
  const [opened, setOpened] = useState(0);
  return (
    <View style={{ width: 1920, height: 1080, padding: 74, backgroundColor: "#151920" }}>
      <Text
        nativeID="shelves-position"
        style={{ width: 1500, height: 64, fontSize: 40, color: "white" }}
      >
        {titles[focused.row]} · Route {focused.number} · Opened {opened}
      </Text>
      {titles.map((title, row) => (
        <View key={title} nativeID={"shelves-row-" + row} style={{ height: 142 }}>
          <Text style={{ width: 500, height: 36, fontSize: 26, color: "white" }}>{title}</Text>
          <View style={{ flexDirection: "row", height: 98 }}>
            {cards.map((number) => (
              <Pressable
                nativeID={`shelves-card-${row}-${number}`}
                key={number}
                hasTVPreferredFocus={row === 0 && number === 1}
                onFocus={() => setFocused({ row, number })}
                onPress={() => setOpened((count) => count + 1)}
                style={({ focused }) => ({
                  width: 130,
                  height: 94,
                  marginRight: 12,
                  padding: 10,
                  backgroundColor: focused ? "#385fb9" : "#29364e",
                })}
              >
                <Text style={{ width: 110, height: 40, fontSize: 29, color: "white" }}>
                  Route {number}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}
