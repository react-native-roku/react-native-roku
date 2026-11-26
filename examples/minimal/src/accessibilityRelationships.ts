import { createElement } from "react";
import { createNativeRoot, NativeInput } from "react-native-roku";
import { NativeSystemState } from "react-native-roku/system";
import { RecordingSceneGraph } from "react-native-roku/testing";
import { Pressable, Text, View } from "react-native";

/** An independent installed consumer: explicit host focus/speech observations,
 * with no private imports or claim about firmware accessibility. */
export async function qualifyAccessibilityRelationships() {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput(),
    speech: string[] = [];
  const system = new NativeSystemState({ screenReader: true }, (message) => speech.push(message));
  const root = createNativeRoot(scene, {
    input,
    system,
    strictMode: true,
    viewport: { width: 640, height: 360 },
    text: {
      prepare() {},
      metrics: () => ({ lineHeight: 20, width: (value: string) => value.length * 8 }),
    },
  });
  const equal = (actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw Error(`Packed label relationship mismatch: ${JSON.stringify({ actual, expected })}`);
  };
  const focus = () => {
    const node = [...scene.nodes.values()].find((node) => node.fields.id === "control");
    if (!node) throw Error("Packed relationship control is missing");
    scene.emit(node, "focusedChild", "control");
  };
  const render = async (first: string | null, hidden = false, native = false) => {
    root.render(
      createElement(
        View,
        {},
        first === null ? null : createElement(Text, { key: first, nativeID: "first" }, first),
        createElement(Text, { nativeID: "second", "aria-hidden": hidden }, "Beta"),
        createElement(Pressable, {
          nativeID: "control",
          role: "button",
          accessibilityLabel: "Fallback",
          ...(native
            ? { accessibilityLabelledBy: ["second", "missing", "first", "second"] }
            : { "aria-labelledby": " second\tmissing\nfirst second " }),
        }),
      ),
    );
    await root.whenCommitted();
  };
  try {
    await render("Alpha");
    equal(speech, []);
    focus();
    equal(speech.at(-1), "Beta Alpha Beta, button");
    await render("Changed");
    equal(speech.at(-1), "Beta Changed Beta, button");
    const count = speech.length;
    await render("Changed", false, true);
    equal(speech.length, count);
    await render(null);
    equal(speech.at(-1), "Beta Beta, button");
    await render(null, true);
    equal(speech.at(-1), "Fallback, button");
    root.render(
      createElement(
        View,
        {},
        createElement(Text, { nativeID: "first", "aria-labelledby": "second" }, "Alpha"),
        createElement(Text, { nativeID: "second", "aria-labelledby": "first" }, "Beta"),
        createElement(Pressable, {
          nativeID: "control",
          role: "button",
          accessibilityLabelledBy: ["first", "second"],
        }),
      ),
    );
    await root.whenCommitted();
    focus();
    equal(speech.at(-1), "Alpha Beta, button");
    // The source follows its modal consumer: exposure must already be final.
    root.render(
      createElement(
        View,
        {},
        createElement(
          View,
          { nativeID: "dialog", "aria-modal": true },
          createElement(Pressable, {
            nativeID: "control",
            role: "button",
            "aria-labelledby": "outside",
            accessibilityLabel: "Inside",
          }),
        ),
        createElement(Text, { nativeID: "outside" }, "Outside"),
      ),
    );
    await root.whenCommitted();
    focus();
    equal(speech.at(-1), "Inside, button");
  } finally {
    root.unmount();
    input.dispose();
  }
  equal(scene.nodes.size, 1);
  equal(scene.listenerCount, 0);
  equal(input.targetCount, 0);
  return {
    orderedIds: true,
    nativeAlias: true,
    replacement: true,
    exposure: true,
    cyclesBounded: true,
    cleanup: true,
  };
}
