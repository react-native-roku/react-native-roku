import { useEffect, useRef, useState } from "react";
import { Modal, Pressable, Text, TextInput, View } from "react-native";

import storage from "react-native-roku/async-storage";

const layoutKey = "compact-layout";

export default function Settings() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("Guest");
  const [layout, setLayout] = useState<"Comfortable" | "Compact" | "Loading" | "Error">("Loading");
  const saving = useRef(false);
  useEffect(() => {
    let mounted = true;
    storage.getItem(layoutKey).then(
      (value) => {
        if (mounted)
          setLayout(value === "1" ? "Compact" : value === null ? "Comfortable" : "Error");
      },
      () => {
        if (mounted) setLayout("Error");
      },
    );
    return () => {
      mounted = false;
    };
  }, []);
  async function toggleLayout() {
    if (saving.current || (layout !== "Comfortable" && layout !== "Compact")) return;
    saving.current = true;
    try {
      if (layout === "Compact") {
        await storage.removeItem(layoutKey);
        setLayout("Comfortable");
      } else {
        await storage.setItem(layoutKey, "1");
        setLayout("Compact");
      }
    } catch {
      setLayout("Error");
    } finally {
      saving.current = false;
    }
  }
  return (
    <View style={{ width: 1920, height: 1080, padding: 60 }}>
      <Text nativeID="settings-title">Settings</Text>
      <Pressable
        nativeID="settings-edit"
        accessibilityRole="button"
        accessibilityLabel="Edit profile"
        hasTVPreferredFocus={!open}
        onPress={() => setOpen(true)}
      >
        <Text>Edit profile</Text>
      </Pressable>
      <Text nativeID="settings-value">{name}</Text>
      <Pressable nativeID="settings-layout" accessibilityRole="button" onPress={toggleLayout}>
        <Text>Change layout</Text>
      </Pressable>
      <Text nativeID="settings-layout-value">{layout}</Text>
      <Modal visible={open} onRequestClose={() => setOpen(false)}>
        <View style={{ width: 640, height: 400, backgroundColor: "black", padding: 24 }}>
          <Text>Profile name</Text>
          <TextInput
            nativeID="settings-name"
            accessibilityLabel="Profile name"
            value={name}
            onChangeText={setName}
          />
          <Pressable
            nativeID="settings-done"
            accessibilityRole="button"
            hasTVPreferredFocus
            onPress={() => setOpen(false)}
          >
            <Text>Done</Text>
          </Pressable>
        </View>
      </Modal>
    </View>
  );
}
