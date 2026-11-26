import { createElement } from "react";
import { createNativeRoot, NativeInput } from "react-native-roku";
import { NativeSystemState } from "react-native-roku/system";
import { RecordingSceneGraph } from "react-native-roku/testing";
import { Text, View } from "react-native";

/** Port submission is observable; firmware speech and cancellation are not. */
export async function qualifyAccessibilityRetirement() {
  const results: { transition: string; messages: string[] }[] = [];
  for (const transition of ["unmount", "replace"] as const) {
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
    root = createNativeRoot(scene, {
      input,
      system,
      viewport: { width: 400, height: 200 },
      text: {
        prepare() {},
        metrics: () => ({ lineHeight: 20, width: (value: string) => value.length * 8 }),
      },
    });
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
      const expected = transition === "unmount" ? ["First"] : ["First", "Successor"];
      if (JSON.stringify(messages) !== JSON.stringify(expected))
        throw Error(`Packed announcement retirement ${transition}: ${JSON.stringify(messages)}`);
      results.push({ transition, messages });
    } finally {
      root.unmount();
      input.dispose();
    }
    if (scene.nodes.size !== 1 || scene.listenerCount || system.listenerCount)
      throw Error("Packed announcement ownership did not retire");
  }
  return {
    results,
    cleanup: true,
    scope: "Committed host publication lifetime; synthetic port submission only",
  };
}
