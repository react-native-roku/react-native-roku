import { KeyHandler } from "@roku-sdk/components";
import { defineAnchorNode, main, registerAnchorNode } from "@roku-sdk/rsg-ts";
import {
  createSelector,
  createSignal,
  For,
  onCleanup,
  registerSetPropertyObserver,
} from "@roku-sdk/solid";
import Catalog from "./CatalogScreen";
import { activation, catalog, marks } from "./shelfMode";
import { deliverFocus, field, keyEvent, mark, requestFocus } from "./shelfTrace";
import {
  cardColor,
  cardFontSize,
  cardHeight,
  cardLabelHeight,
  cardWidth,
  focusColor,
  next,
  tiles,
  title,
  titleColor,
  titleFontSize,
  titleFrame,
} from "./shelf";
import inter from "./Inter_400Regular.ttf";
import "./NativeShelfScene.xml";

const color = (value: string) => "0x" + value.slice(1) + "FF";
const anchor = defineAnchorNode(
  {
    componentName: "NativeShelfAnchor",
    extends: "Group",
    inputFields: {},
    outputFields: {},
  },
  () => {
    if (catalog) return <Catalog />;
    const [active, setActive] = createSignal(0);
    const isActive = createSelector(active);
    let nativeCard = 0;
    let held: number | undefined;
    if (marks)
      onCleanup(
        registerSetPropertyObserver((node, name, value) => field(node, node.parent, name, value)),
      );
    const handleKey = (key: string, press: boolean) => {
      if (key === "OK" || key === "enter") {
        if (press) {
          if (nativeCard === active()) held ??= nativeCard;
        } else {
          const card = held;
          held = undefined;
          if (card !== undefined && card === nativeCard && card === active())
            mark("press.handler", { target: tiles[card].id });
        }
        return;
      }
      if (!press) return;
      const destination = next(active(), key);
      if (destination === active()) return;
      held = undefined;
      if (marks) requestFocus(tiles[destination].id);
      setActive(destination);
      console.log("SHELF_TARGET", tiles[destination].id, performance.now());
    };
    const cardFont = <font uri={inter} size={cardFontSize} />;
    const titleFont = <font uri={inter} size={titleFontSize} />;
    return (
      <KeyHandler
        id="shelf-keys"
        focusable
        keys={
          activation
            ? ["left", "right", "up", "down", "OK", "enter"]
            : ["left", "right", "up", "down"]
        }
        onKeyEvent={({ key, press }) =>
          marks ? keyEvent(key, press, () => handleKey(key, press)) : handleKey(key, press)
        }
      >
        <label
          id="selection"
          translation={[titleFrame.left, titleFrame.top]}
          width={titleFrame.width}
          height={titleFrame.height}
          text={title(active())}
          font={titleFont}
          color={color(titleColor)}
          horizAlign="left"
          vertAlign="top"
        />
        <For each={tiles}>
          {(tile) => (
            <group
              id={tile.id}
              translation={[tile.x, tile.y]}
              focusable
              gainFocus={isActive(tile.index)}
              onFocusedChild={
                marks || activation
                  ? (value: unknown) => {
                      if (value !== tile.id) return;
                      nativeCard = tile.index;
                      if (marks) deliverFocus(tile.id, true);
                    }
                  : undefined
              }
            >
              <rectangle
                width={cardWidth}
                height={cardHeight}
                color={color(isActive(tile.index) ? focusColor : cardColor)}
              />
              <label
                width={cardWidth}
                height={cardLabelHeight}
                text={tile.title}
                font={cardFont}
                color={color(titleColor)}
                horizAlign="left"
                vertAlign="top"
              />
            </group>
          )}
        </For>
      </KeyHandler>
    );
  },
);

main(() => registerAnchorNode(anchor));
