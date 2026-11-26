import { createElement } from "react";
import { createNativeRoot, NativeInput } from "react-native-roku";
import { NativeSystemState } from "react-native-roku/system";
import { Text, View, Pressable } from "react-native";
import { RecordingSceneGraph } from "react-native-roku/testing";

/** Direct description relationships through public installed host primitives. */
export async function qualifyAccessibilityDescriptions() {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput(),
    messages: string[] = [];
  const system = new NativeSystemState({ screenReader: true }, (message) => messages.push(message));
  const root = createNativeRoot(scene, {
    input,
    system,
    strictMode: true,
    viewport: { width: 400, height: 200 },
    text: {
      prepare() {},
      metrics: () => ({ lineHeight: 20, width: (value: string) => value.length * 8 }),
    },
  });
  const demand = (condition: unknown, message: string) => {
    if (!condition) throw Error("Packed description: " + message);
  };
  const render = async (
    first: string | null,
    second: string | null,
    hidden = false,
    ids = "second missing first second",
    generation = 0,
  ) => {
    root.render(
      createElement(
        View,
        {},
        first === null
          ? null
          : createElement(Text, { nativeID: "first", key: "first-" + generation }, first),
        second === null
          ? null
          : createElement(Text, { nativeID: "second", "aria-hidden": hidden }, second),
        createElement(Pressable, {
          nativeID: "control",
          role: "button",
          accessibilityLabel: "Answer",
          accessibilityHint: "Native hint",
          "aria-describedby": ids,
        }),
      ),
    );
    for (let index = 0; index < 4; index++) {
      await root.whenCommitted();
      root.flush();
    }
  };
  try {
    await render("Alpha", "Beta");
    demand(messages.length === 0, "references do not invent a focus event");
    const control = [...scene.nodes.values()].find((node) => node.fields.id === "control")!;
    scene.emit(control, "focusedChild", "control");
    demand(
      messages.at(-1) === "Answer, button, Beta Alpha Beta",
      "names must stay separate from ordered descriptions",
    );
    await render("Replacement", "Beta", false, undefined, 1);
    demand(
      messages.at(-1) === "Answer, button, Beta Replacement Beta",
      "committed source replacement must refresh focused semantics",
    );
    await render("Replacement", "Beta", true, undefined, 1);
    demand(
      messages.at(-1) === "Answer, button, Replacement",
      "hidden sources follow the explicit exposed-host profile",
    );
    await render(null, null);
    demand(
      messages.at(-1) === "Answer, button, Native hint",
      "missing sources must retain the native hint fallback",
    );
    await render("", null, false, "first");
    demand(
      messages.at(-1) === "Answer, button",
      "an existing empty description must suppress the fallback hint",
    );
    demand(
      scene.nodes.get(control.id) === control,
      "description changes must retain the current keyed control",
    );
    const count = messages.length;
    await render("", null, false, "first");
    demand(messages.length === count, "unchanged semantics must not repeat requests");
  } finally {
    root.unmount();
    input.dispose();
  }
  demand(
    scene.nodes.size === 1 && scene.listenerCount === 0 && input.targetCount === 0,
    "scene and input ownership must retire",
  );
  return {
    orderedIds: true,
    nameSeparate: true,
    replacement: true,
    missingFallback: true,
    validEmpty: true,
    exposedSources: true,
    cleanup: true,
    scope:
      "Committed host semantics and explicit synthetic focus/Audio Guide requests; native speech/traversal remain pending",
  };
}
