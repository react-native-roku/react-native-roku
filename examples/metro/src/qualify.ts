import { AppRegistry } from "react-native";
import { mountRegisteredApplication } from "react-native-roku/application";
import { RecordingSceneGraph } from "react-native-roku/testing";
import { NativeSystemState } from "react-native-roku/system";
import App, { update, effectSetups, effectCleanups, observedLayout, qualifyIntl } from "./App";
import "./styles";

export const mountApplication = (context) =>
  mountRegisteredApplication(context, {
    appKey: "MetroProof",
    webRuntime: "host",
    load() {
      AppRegistry.registerComponent("MetroProof", () => App);
    },
  });
export const qualify = async () => {
  const profile = { development: __DEV__, nodeEnv: process.env.NODE_ENV };
  if (profile.nodeEnv !== (profile.development ? "development" : "production"))
    throw Error("Metro profile leaked the host NODE_ENV");
  const intl = qualifyIntl();
  const scene = new RecordingSceneGraph(),
    errors: string[] = [];
  const app = mountApplication({
    scene,
    system: new NativeSystemState({ colorScheme: "light", reduceMotion: false }),
    viewport: { width: 800, height: 600 },
    text: {
      prepare() {},
      metrics() {
        return { lineHeight: 20, width: (value) => value.length * 7 };
      },
    },
    onError(error) {
      errors.push(error.message);
    },
  });
  const texts = () =>
    [...scene.nodes.values()]
      .map((node) => node.fields.text)
      .filter((value) => typeof value === "string");
  try {
    await app.whenCommitted();
    const cold = texts();
    if (!cold.includes("Metro cold start")) throw Error("Metro cold tree did not render");
    if (
      !cold.includes("Styled field") ||
      ![...scene.nodes.values()].some((node) => node.fields.id === "metro-focus-input")
    )
      throw Error("Metro focus-styled TextInput did not reach its mounted display owner");
    if (observedLayout?.width !== 320 || observedLayout.height !== 120)
      throw Error("Metro lost compiled CSS interop geometry: " + JSON.stringify(observedLayout));
    update("Metro state updated");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await app.whenCommitted();
    const updated = texts();
    if (!updated.includes("Metro state updated")) throw Error("Metro React state did not commit");
    app.dispose();
    if (
      scene.nodes.size !== 1 ||
      scene.listenerCount ||
      errors.length ||
      effectSetups !== 1 ||
      effectCleanups !== 1
    )
      throw Error("Metro lifecycle did not retire");
    return {
      cold,
      updated,
      nodes: scene.nodes.size,
      listeners: scene.listenerCount,
      effectSetups,
      effectCleanups,
      observedLayout,
      intl,
      profile,
      errors,
    };
  } finally {
    app.dispose();
  }
};
