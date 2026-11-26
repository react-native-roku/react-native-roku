import { useEffect, useLayoutEffect, useState, useRef, type ElementRef } from "react";
import { BackHandler, FlatList, Modal, Pressable, Text, TextInput, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";

const items = [
  { id: "atlas", title: "Atlas" },
  { id: "orchard", title: "Orchard" },
];
type Item = (typeof items)[number];
const metrics = {
  frame: { x: 0, y: 0, width: 320, height: 240 },
  insets: { top: 12, right: 0, bottom: 0, left: 16 },
};

type CatalogEvent = (event: string) => void;

export function CatalogAdoptionFixture({ onEvent }: { onEvent?: CatalogEvent } = {}) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>
      <Catalog onEvent={onEvent} />
    </SafeAreaProvider>
  );
}

function Catalog({ onEvent }: { onEvent?: CatalogEvent }) {
  const insets = useSafeAreaInsets();
  const [selected, setSelected] = useState<Item>();
  const [last, setLast] = useState(items[0].id);
  const [listGeneration, setListGeneration] = useState(1);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const editFocus = useRef<ElementRef<typeof Pressable>>(null);
  const saveFocus = useRef<ElementRef<typeof Pressable>>(null);
  useEffect(() => {
    if (editing) return;
    if (selected) editFocus.current?.focus();
  }, [selected, editing]);
  useEffect(() => {
    if (!selected || editing) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      closeDetails();
      return true;
    });
    return () => subscription.remove();
  }, [selected, editing]);

  function closeDetails() {
    setListGeneration((value) => value + 1);
    setSelected(undefined);
  }

  return (
    <View style={{ marginTop: insets.top, marginLeft: insets.left, width: 320, height: 240 }}>
      {selected ? (
        <>
          <Text nativeID="adoption-title">{selected.title} details</Text>
          <Text nativeID="adoption-note">{notes[selected.id] || "No note"}</Text>
          <Pressable
            ref={editFocus}
            nativeID="adoption-edit"
            onPress={() => {
              onEvent?.("detail:edit");
              setDraft(notes[selected.id] ?? "");
              setEditing(true);
            }}
          >
            <Text>Edit note</Text>
          </Pressable>
          <Pressable nativeID="adoption-back" onPress={closeDetails}>
            <Text>Back to catalog</Text>
          </Pressable>
          <Modal
            visible={editing}
            transparent
            onShow={() => saveFocus.current?.focus()}
            onRequestClose={() => {
              onEvent?.("modal:back");
              setEditing(false);
            }}
          >
            <View style={{ width: 320, height: 180, backgroundColor: "#24272b" }}>
              <Text>Note editor</Text>
              <TextInput
                nativeID="adoption-input"
                accessibilityLabel="Note"
                value={draft}
                onChangeText={setDraft}
                style={{ width: 240, height: 40, color: "white" }}
              />
              <Pressable
                ref={saveFocus}
                nativeID="adoption-save"
                onPress={() => {
                  setNotes((current) => ({ ...current, [selected.id]: draft }));
                  setEditing(false);
                }}
              >
                <Text>Save note</Text>
              </Pressable>
            </View>
          </Modal>
        </>
      ) : (
        <CatalogList
          generation={listGeneration}
          last={last}
          onEvent={onEvent}
          onSelect={(item) => {
            setLast(item.id);
            setSelected(item);
          }}
        />
      )}
    </View>
  );
}

function CatalogList({
  generation,
  last,
  onEvent,
  onSelect,
}: {
  generation: number;
  last: string;
  onEvent?: CatalogEvent;
  onSelect: (item: Item) => void;
}) {
  const [focused, setFocused] = useState<string>();
  const listFocus = useRef<ElementRef<typeof Pressable>>(null);
  useLayoutEffect(() => {
    onEvent?.(`list:${generation}:mount`);
    return () => onEvent?.(`list:${generation}:unmount`);
  }, [generation, onEvent]);
  return (
    <>
      <Text>Catalog</Text>
      <Text>
        {focused ? `Focused ${generation}: ${focused}` : `Waiting for focus ${generation}`}
      </Text>
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => {
          const trace = (event: string) => onEvent?.(`row:${generation}:${item.id}:${event}`);
          return (
            <Pressable
              ref={item.id === last ? listFocus : undefined}
              nativeID={"adoption-item-" + item.id}
              onLayout={
                item.id === last
                  ? () => {
                      trace("focus-request");
                      listFocus.current?.focus();
                    }
                  : undefined
              }
              onFocus={() => {
                trace("focus");
                setFocused(item.title);
              }}
              onBlur={() => {
                trace("blur");
                setFocused(undefined);
              }}
              onPressIn={() => trace("press-in")}
              onPressOut={() => trace("press-out")}
              accessibilityRole="button"
              accessibilityState={{ selected: last === item.id }}
              onPress={() => {
                trace("activate");
                onSelect(item);
              }}
              style={{ width: 240, height: 44 }}
            >
              <Text>{item.title}</Text>
            </Pressable>
          );
        }}
      />
    </>
  );
}
