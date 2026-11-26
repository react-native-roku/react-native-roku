import { KeyHandler } from "@roku-sdk/components";
import { createSelector, createSignal, For, Show } from "@roku-sdk/solid";
import {
  catalogHeight,
  catalogLeft,
  catalogTitle,
  catalogTop,
  catalogWidth,
  cardLeft,
  cardTop,
  detailTitle,
  scrollFor,
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
  viewport,
} from "./shelf";
import { fullCatalogTitles } from "./fullCatalogTitles";
import inter from "./Inter_400Regular.ttf";

const color = (value: string) => "0x" + value.slice(1) + "FF";

export default function Catalog() {
  const [active, setActive] = createSignal(0);
  const [requested, request] = createSignal<number | null>(0);
  const [detail, setDetail] = createSignal<number | null>(null);
  const [offset, setOffset] = createSignal(0);
  const isActive = createSelector(active);
  const isRequested = createSelector(requested);
  let selectDown = false;
  let pendingSelect = false;
  const navigate = (key: string, press: boolean) => {
    if (key === "back" && press && detail() !== null) {
      setDetail(null);
      request(active());
    } else if (key === "OK" || key === "enter") {
      if (press) selectDown = true;
      else if (selectDown) {
        selectDown = false;
        if (detail() !== null) {
          setDetail(null);
          request(active());
        } else if (requested() === active()) setDetail(active());
        else pendingSelect = true;
      }
    } else if (press && detail() === null) {
      pendingSelect = false;
      const destination = next(requested() ?? active(), key);
      if (destination !== requested()) request(destination);
    }
  };
  const font = <font uri={inter} size={titleFontSize} />;
  const cardFont = <font uri={inter} size={cardFontSize} />;
  // The frozen catalog has short titles and three-line descriptions at this width.
  const titleLines = () => (catalogTitle(active()) === title(active()) ? 1 : 3);
  return (
    <KeyHandler
      id="shelf-keys"
      focusable
      keys={["left", "right", "up", "down", "OK", "enter", "back"]}
      onKeyEvent={({ key, press }) => navigate(key, press)}
    >
      <label
        id="selection"
        translation={[titleFrame.left, titleFrame.top]}
        width={titleFrame.width}
        height={fullCatalogTitles ? 39 * titleLines() : 120}
        wrap
        lineSpacing={fullCatalogTitles ? 0 : undefined}
        numLines={fullCatalogTitles ? titleLines() : undefined}
        text={catalogTitle(active())}
        font={font}
        color={color(titleColor)}
        horizAlign="left"
        vertAlign="top"
      />
      <group
        id="catalog-window"
        translation={[catalogLeft, catalogTop]}
        clippingRect={[0, 0, catalogWidth, catalogHeight]}
      >
        <group id="catalog-content" translation={[0, -offset()]}>
          <For each={tiles}>
            {({ index, id, title }) => (
              <group
                id={id}
                translation={[cardLeft(index), cardTop(index)]}
                focusable={detail() === null}
                gainFocus={detail() === null && isRequested(index)}
                onFocusedChild={(value: unknown) => {
                  if (value !== id) return;
                  setActive(index);
                  setOffset(scrollFor(index, offset()));
                  if (pendingSelect && requested() === index) {
                    pendingSelect = false;
                    setDetail(index);
                  }
                }}
              >
                <rectangle
                  width={cardWidth}
                  height={cardHeight}
                  color={color(isActive(index) ? focusColor : cardColor)}
                />
                <label
                  width={cardWidth}
                  height={cardLabelHeight}
                  text={title}
                  font={cardFont}
                  color={color(titleColor)}
                  horizAlign="left"
                  vertAlign="top"
                />
              </group>
            )}
          </For>
        </group>
      </group>
      <Show when={detail() !== null}>
        <rectangle {...viewport} color="0x101014FF" />
        <label
          id="details"
          translation={[titleFrame.left, titleFrame.top]}
          width={titleFrame.width}
          height={titleFrame.height}
          text={detailTitle(detail()!)}
          font={font}
          color={color(titleColor)}
          horizAlign="left"
          vertAlign="top"
        />
        <group id="back-to-catalog" translation={[catalogLeft, catalogTop]} focusable gainFocus>
          <rectangle width={cardWidth} height={cardHeight} color={color(focusColor)} />
          <label
            width={cardWidth}
            height={cardLabelHeight}
            text="Back"
            font={cardFont}
            color={color(titleColor)}
            horizAlign="left"
            vertAlign="top"
          />
        </group>
      </Show>
    </KeyHandler>
  );
}
