import { createElement } from "react";
import { expect, it } from "vitest";
import { createNativeRoot } from "./createNativeRoot";
import { NativeSystemState } from "./NativeSystemState";
import { NativeInput } from "./NativeInput";
import { Text, View, Pressable } from "./primitives";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";

const text = {
  prepare() {},
  metrics: () => ({ lineHeight: 20, width: (value: string) => value.length * 8 }),
};

for (const transition of ["unmount", "replace"] as const) {
  it(`retires the remaining live-region delivery after announcement port ${transition}`, async () => {
    const scene = new RecordingSceneGraph(),
      input = new NativeInput(),
      messages: string[] = [];
    let root: ReturnType<typeof createNativeRoot>;
    const system = new NativeSystemState({ screenReader: true }, (message) => {
      messages.push(message);
      if (message !== "First") return;
      if (transition === "unmount") root.unmount();
      else
        root.runSync(() =>
          root.render(
            createElement(Text, { nativeID: "second", "aria-live": "polite" }, "Successor"),
          ),
        );
    });
    root = createNativeRoot(scene, { input, system, text, viewport: { width: 800, height: 600 } });
    try {
      root.render(
        createElement(
          View,
          {},
          createElement(Text, { nativeID: "first", "aria-live": "polite" }, "First"),
          createElement(Text, { nativeID: "second", "aria-live": "polite" }, "Retired"),
        ),
      );
      await root.whenCommitted();
      expect(messages).toEqual(transition === "unmount" ? ["First"] : ["First", "Successor"]);
      if (transition === "replace") {
        root.render(
          createElement(Text, { nativeID: "second", "aria-live": "polite" }, "Successor"),
        );
        await root.whenCommitted();
        expect(messages).toEqual(["First", "Successor"]);
      }
    } finally {
      root.unmount();
      input.dispose();
      expect(scene.nodes.size).toBe(1);
      expect(scene.listenerCount).toBe(0);
      expect(system.listenerCount).toBe(0);
    }
  });
}

it("retires pending live regions when refreshed focus speech unmounts the root", async () => {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput(),
    messages: string[] = [];
  let root: ReturnType<typeof createNativeRoot>;
  const system = new NativeSystemState({ screenReader: true }, (message) => {
    messages.push(message);
    if (message === "Updated, button") root.unmount();
  });
  root = createNativeRoot(scene, { input, system, text, viewport: { width: 800, height: 600 } });
  const render = (label: string, live: boolean) =>
    root.render(
      createElement(
        View,
        {},
        createElement(Pressable, {
          nativeID: "control",
          role: "button",
          accessibilityLabel: label,
        }),
        live ? createElement(Text, { nativeID: "notice", "aria-live": "polite" }, "Retired") : null,
      ),
    );
  try {
    render("Initial", false);
    await root.whenCommitted();
    const node = [...scene.nodes.values()].find((node) => node.fields.id === "control")!;
    scene.emit(node, "focusedChild", "control");
    render("Updated", true);
    await root.whenCommitted();
    expect(messages).toEqual(["Initial, button", "Updated, button"]);
  } finally {
    root.unmount();
    input.dispose();
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
    expect(system.listenerCount).toBe(0);
  }
});
