import { KeyHandler } from "@roku-sdk/components";
import { createSignal, For, Show } from "@roku-sdk/solid";
import cover from "./catalog-cover.png";
import inter from "./Inter_400Regular.ttf";
import { narrow, reveal, routes, rowHeight, wide, windowHeight } from "./holdout";

export default function Holdout() {
  const [items, setItems] = createSignal(routes);
  const [requested, request] = createSignal(routes[0].id);
  const [focused, focus] = createSignal(routes[0].id);
  const [offset, scroll] = createSignal(0);
  const [detail, show] = createSignal(false);
  const [compact, resize] = createSignal(false);
  const [button, selectButton] = createSignal("holdout-resize");
  const [nativeButton, observeButton] = createSignal("");
  const active = () => items().findIndex((item) => item.id === focused());
  const visible = () => {
    const top = Math.floor(offset() / rowHeight);
    return items().slice(Math.max(0, top - 3), top + 6);
  };
  let pressed: string | undefined;
  const navigate = (key: string, press: boolean) => {
    if (key === "back" && press && detail()) {
      pressed = undefined;
      show(false);
      return;
    }
    if (key === "OK" || key === "enter") {
      const target = detail() ? nativeButton() : focused();
      if (press) {
        pressed ??= target;
        return;
      }
      const original = pressed;
      pressed = undefined;
      if (!target || original !== target) return;
      if (!detail() && requested() === focused()) {
        selectButton("holdout-resize");
        resize(false);
        show(true);
      } else if (detail() && nativeButton() === button()) {
        if (button() === "holdout-resize") resize(!compact());
        else if (items().length > 1) {
          const i = active();
          const other = items()[i + 1] ?? items()[i - 1];
          const remaining = items().filter((item) => item.id !== focused());
          request(other.id);
          focus(other.id);
          setItems(remaining);
          show(false);
        }
      }
      return;
    }
    if (!press || (key !== "down" && key !== "up")) return;
    pressed = undefined;
    if (detail()) {
      selectButton(key === "down" ? "holdout-remove" : "holdout-resize");
      return;
    }
    const i = items().findIndex((item) => item.id === requested()) + (key === "down" ? 1 : -1);
    if (items()[i]) request(items()[i].id);
  };
  const font = <font uri={inter} size={26} />;
  const titleFont = <font uri={inter} size={28} />;
  return (
    <KeyHandler
      focusable
      keys={["up", "down", "OK", "enter", "back"]}
      onKeyEvent={({ key, press }) => navigate(key, press)}
    >
      <Show when={!detail()}>
        <group id="holdout-window" clippingRect={[0, 0, wide, windowHeight]}>
          <group translation={[0, -offset()]}>
            <For each={visible()}>
              {(item) => (
                <group
                  id={item.id}
                  translation={[0, items().indexOf(item) * rowHeight]}
                  focusable
                  gainFocus={item.id === requested()}
                  onFocusedChild={(value: unknown) => {
                    if (value === item.id) {
                      focus(item.id);
                      scroll(reveal(items().indexOf(item), offset()));
                    }
                  }}
                >
                  <rectangle
                    width={wide}
                    height={rowHeight}
                    color={focused() === item.id ? "0x3456C0FF" : "0x303040FF"}
                  />
                  <poster uri={cover.uri} width={96} height={rowHeight} />
                  <label
                    text={item.title}
                    translation={[96, 0]}
                    width={600}
                    height={rowHeight}
                    wrap
                    font={font}
                  />
                </group>
              )}
            </For>
          </group>
        </group>
      </Show>
      <Show when={detail()}>
        <label
          id="holdout-title"
          text={items()[active()]?.title}
          width={compact() ? narrow : wide}
          wrap
          font={titleFont}
          vertAlign="top"
        />
        <For each={["holdout-resize", "holdout-remove"]}>
          {(id, i) => (
            <group
              id={id}
              translation={[0, 220 + i() * 72]}
              focusable
              gainFocus={button() === id}
              onFocusedChild={(value: unknown) => {
                if (value === id) observeButton(id);
              }}
            >
              <rectangle
                width={220}
                height={72}
                color={nativeButton() === id ? "0x3456C0FF" : "0x303040FF"}
              />
              <label text={id === "holdout-resize" ? "Change width" : "Remove route"} font={font} />
            </group>
          )}
        </For>
      </Show>
    </KeyHandler>
  );
}
