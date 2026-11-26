import { createElement } from "react";
import { createNativeRoot, NativeInput, NativeSystemState } from "react-native-roku";
import { Text } from "react-native";
import { TextRasterCache } from "react-native-roku/text-raster-cache";
import { RecordingSceneGraph } from "react-native-roku/testing";

/** Actual bounded cache/root ownership with explicitly failing cleanup ports. */
export async function qualifyCleanupLifetimes() {
  const results = [];
  for (const kind of ["font", "raster", "latched"] as const) {
    const scene = new RecordingSceneGraph(),
      input = new NativeInput(),
      system = new NativeSystemState({ appState: "active" }),
      fontError = Error("font cleanup"),
      rasterError = Error("raster cleanup"),
      primary = Error("original mask failure");
    let fontFailures = kind === "raster" ? 0 : 1,
      rasterFailures = kind === "raster" ? 1 : 0,
      fontAttempts = 0,
      rasterAttempts = 0;
    const cache = new TextRasterCache(
      {
        mask: async (spec) => {
          if (kind === "latched") throw primary;
          return new Uint8Array(spec.width * spec.height);
        },
        write: async (name) => "fixture:/" + name,
        delete: async () => {},
        dispose: () => {
          rasterAttempts++;
          if (rasterFailures-- > 0) throw rasterError;
        },
      },
      80_000,
    );
    const root = createNativeRoot(scene, {
      input,
      system,
      textRaster: cache,
      onError() {},
      viewport: { width: 300, height: 100 },
      text: {
        prepare() {},
        metrics: () => ({ lineHeight: 20, width: (value) => value.length * 8 }),
        dispose: () => {
          fontAttempts++;
          if (fontFailures-- > 0) throw fontError;
        },
      },
    });
    const demand = (condition: unknown, message: string) => {
      if (!condition) throw Error("Packed cleanup: " + message);
    };
    let original: unknown, first: unknown;
    try {
      root.render(
        createElement(Text, { style: { width: 100, height: 20, letterSpacing: 1 } }, "owned"),
      );
      try {
        await root.whenCommitted();
      } catch (error) {
        original = error;
      }
      demand(
        kind === "latched" ? original === primary : original === undefined,
        "preparation result must retain its original identity",
      );
      try {
        root.unmount();
      } catch (error) {
        first = error;
      }
      demand(
        first === (kind === "latched" ? primary : kind === "font" ? fontError : rasterError),
        "the earliest render/cleanup error must remain observable",
      );
      demand(
        rasterAttempts === 1 &&
          cache.diagnostics().entries === 0 &&
          cache.diagnostics().leased === 0,
        "another failing owner must not skip cache retirement",
      );
      demand(
        scene.nodes.size === 1 &&
          scene.listenerCount === 0 &&
          input.targetCount === 0 &&
          input.observerCount === 0 &&
          system.listenerCount === 0,
        "scene and service bindings must retire before reporting failure",
      );
      root.unmount();
      root.unmount();
      demand(
        fontAttempts === (kind === "raster" ? 1 : 2) &&
          rasterAttempts === (kind === "raster" ? 2 : 1),
        "only failed cleanup work can run again",
      );
      demand(!root.mounted, "cleanup retry must not revive the root");
      results.push({
        kind,
        originalPreserved: true,
        fontAttempts,
        rasterAttempts,
        entries: cache.diagnostics().entries,
        retired: true,
      });
    } finally {
      root.unmount();
      input.dispose();
    }
  }
  return results;
}
