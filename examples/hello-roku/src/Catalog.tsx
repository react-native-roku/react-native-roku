import { useEffect, useRef, useState, type ElementRef } from "react";
import { BackHandler, FlatList, Image, Modal, Pressable, Text, View } from "react-native";
import cover from "./catalog-cover.png";

const columns = 4;
const rowHeight = 200;
const viewportHeight = 680;
const longTitle =
  "A field guide to the mountain passes, alpine lakes, and winding roads of the northern range";
const catalog = Array.from({ length: 72 }, (_, index) => ({
  id: `catalog-card-${index}`,
  index,
  title: index % 7 === 2 ? longTitle : `Mountain route ${index + 1}`,
  disabled: index === 1,
}));
type Card = (typeof catalog)[number];
type CatalogPosition = { card: Card; offset: number };

const buttonStyle = ({ focused }: { focused: boolean }) => ({
  width: 320,
  height: 64,
  padding: 12,
  backgroundColor: focused ? "#3456c0" : "#303040",
});

export default function Catalog() {
  const [detail, setDetail] = useState<Card>();
  const position = useRef<CatalogPosition>({ card: catalog[0], offset: 0 });
  return (
    <View style={{ width: 1920, height: 1080, padding: 80, backgroundColor: "#101014" }}>
      {detail ? (
        <Detail card={detail} onBack={() => setDetail(undefined)} />
      ) : (
        <Grid
          initial={position.current}
          onOpen={(next) => {
            position.current = next;
            setDetail(next.card);
          }}
        />
      )}
    </View>
  );
}

function Grid({
  initial,
  onOpen,
}: {
  initial: CatalogPosition;
  onOpen: (next: CatalogPosition) => void;
}) {
  const list = useRef<ElementRef<typeof FlatList<Card>>>(null);
  const offset = useRef(initial.offset);
  const restoring = useRef(initial.offset !== 0);
  const [focused, setFocused] = useState(initial.card.index);
  const [restoreFocus, setRestoreFocus] = useState(true);
  const rowFor = (card: Card) => Math.floor(card.index / columns);
  const moveList = (next: number) => {
    offset.current = next;
    list.current?.scrollToOffset({ offset: next, animated: false });
  };
  return (
    <>
      <Text nativeID="catalog-heading" style={{ fontSize: 44, color: "white" }}>
        Mountain routes
      </Text>
      <Text nativeID="catalog-position" style={{ fontSize: 27, color: "white", height: 54 }}>
        {focused + 1} of {catalog.length}
      </Text>
      <FlatList
        ref={list}
        nativeID="catalog-grid"
        data={catalog}
        numColumns={columns}
        style={{ width: 1560, height: viewportHeight, flexGrow: 0 }}
        initialScrollIndex={rowFor(initial.card)}
        initialNumToRender={5}
        windowSize={3}
        getItemLayout={(_, index) => ({ index, length: rowHeight, offset: index * rowHeight })}
        keyExtractor={(item) => item.id}
        onLayout={() => {
          if (!restoring.current) return;
          restoring.current = false;
          moveList(initial.offset);
        }}
        onScroll={(event) => {
          if (!restoring.current) offset.current = event.nativeEvent.contentOffset.y;
        }}
        renderItem={({ item }) => (
          <Pressable
            nativeID={item.id}
            disabled={item.disabled}
            hasTVPreferredFocus={restoreFocus && item.id === initial.card.id}
            accessibilityRole="button"
            accessibilityState={{ disabled: item.disabled }}
            onFocus={() => {
              // The initial target can remount while the user navigates the virtual window.
              if (restoreFocus && item.id === initial.card.id) setRestoreFocus(false);
              setFocused(item.index);
              if (restoring.current) return;
              const top = rowFor(item) * rowHeight;
              if (top < offset.current) moveList(top);
              else if (top + rowHeight > offset.current + viewportHeight)
                moveList(top + rowHeight - viewportHeight);
            }}
            onPress={() => onOpen({ card: item, offset: offset.current })}
            style={({ focused }) => ({
              width: 366,
              height: rowHeight - 12,
              marginRight: 16,
              marginBottom: 12,
              padding: 12,
              backgroundColor: item.disabled ? "#202027" : focused ? "#3456c0" : "#303040",
            })}
          >
            <Image source={cover} style={{ width: 342, height: 93 }} resizeMode="cover" />
            <Text
              nativeID={item.id + "-title"}
              style={{ fontSize: 24, lineHeight: 29, color: "white" }}
              numberOfLines={2}
            >
              {item.title}
            </Text>
          </Pressable>
        )}
      />
    </>
  );
}

function Detail({ card, onBack }: { card: Card; onBack: () => void }) {
  const [showInfo, setShowInfo] = useState(false);
  const info = useRef<ElementRef<typeof Pressable>>(null);
  useEffect(() => {
    if (showInfo) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onBack();
      return true;
    });
    return () => subscription.remove();
  }, [onBack, showInfo]);
  const dismiss = () => setShowInfo(false);
  return (
    <>
      <Text nativeID="catalog-detail-title" style={{ fontSize: 44, color: "white", width: 1000 }}>
        {card.title}
      </Text>
      <Image source={cover} style={{ width: 720, height: 320, marginVertical: 32 }} />
      <Pressable
        ref={info}
        nativeID="catalog-info"
        hasTVPreferredFocus
        accessibilityRole="button"
        onPress={() => setShowInfo(true)}
        style={buttonStyle}
      >
        <Text style={{ fontSize: 28, color: "white" }}>Route information</Text>
      </Pressable>
      <Pressable
        nativeID="catalog-back"
        accessibilityRole="button"
        onPress={onBack}
        style={buttonStyle}
      >
        <Text style={{ fontSize: 28, color: "white" }}>Back to routes</Text>
      </Pressable>
      <Modal
        visible={showInfo}
        transparent
        onRequestClose={dismiss}
        onDismiss={() => info.current?.focus()}
      >
        <View
          style={{
            width: 700,
            height: 260,
            padding: 32,
            marginTop: 260,
            marginLeft: 420,
            backgroundColor: "#20243b",
          }}
        >
          <Text nativeID="catalog-modal-title" style={{ fontSize: 36, color: "white" }}>
            Route {card.index + 1}
          </Text>
          <Pressable
            nativeID="catalog-modal-close"
            hasTVPreferredFocus
            accessibilityRole="button"
            onPress={dismiss}
            style={buttonStyle}
          >
            <Text style={{ fontSize: 28, color: "white" }}>Close</Text>
          </Pressable>
        </View>
      </Modal>
    </>
  );
}
