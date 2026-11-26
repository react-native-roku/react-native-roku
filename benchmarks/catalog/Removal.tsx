import { useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";

const initial = Array.from({ length: 12 }, (_, index) => index);
const rowHeight = 96;

export default function Removal() {
  const [items, setItems] = useState(initial);
  const [preferred, setPreferred] = useState(0);
  const [removed, setRemoved] = useState<number>();
  const [selects, setSelects] = useState(0);
  return (
    <View style={{ width: 1920, height: 1080, padding: 100, backgroundColor: "#151920" }}>
      <Text style={{ fontSize: 42, color: "white" }}>Routes</Text>
      <Text
        nativeID="removal-status"
        style={{ width: 640, height: 52, fontSize: 30, color: "white" }}
      >
        {removed === undefined ? "Hold Select to remove a route" : "Removed route " + (removed + 1)}
      </Text>
      <Text
        nativeID="removal-count"
        style={{ width: 640, height: 52, fontSize: 30, color: "white" }}
      >
        {selects} quick selections
      </Text>
      <FlatList
        data={items}
        keyExtractor={String}
        style={{ width: 640, height: 550, flexGrow: 0 }}
        initialNumToRender={7}
        windowSize={3}
        getItemLayout={(_, index) => ({ length: rowHeight, offset: index * rowHeight, index })}
        renderItem={({ item, index }) => (
          <Pressable
            nativeID={"removal-row-" + item}
            hasTVPreferredFocus={item === preferred}
            onLongPress={() => {
              const neighbor = items[index + 1] ?? items[index - 1];
              if (neighbor === undefined) return;
              setPreferred(neighbor);
              setRemoved(item);
              setItems((current) => current.filter((id) => id !== item));
            }}
            onPress={() => setSelects((count) => count + 1)}
            style={({ focused }) => ({
              width: 550,
              height: 86,
              marginBottom: 10,
              padding: 12,
              backgroundColor: focused ? "#375db8" : "#303b51",
            })}
          >
            <Text style={{ fontSize: 34, color: "white" }}>Route {item + 1}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}
