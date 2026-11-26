import { createElement } from "react";
import { it, expect } from "vitest";
import { AppRegistry } from "./AppRegistry";
import { mountRegisteredApplication } from "./mountApplication";
import { Text } from "../react-native/primitives";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import { NativeSystemState } from "../react-native/NativeSystemState";
it("loads registration after the host is bound, renders props, and retires the input/root", async () => {
  const scene = new RecordingSceneGraph();
  const app = mountRegisteredApplication(
    {
      scene,
      system: new NativeSystemState({ appState: "active" }),
      viewport: { width: 640, height: 360 },
      text: {
        prepare() {},
        metrics: () => ({ lineHeight: 20, width: (value) => value.length * 8 }),
      },
      textRaster: {
        dispose() {},
        async acquire() {
          throw Error("unexpected raster");
        },
      },
      webTransport: async () => {
        throw Error("unexpected network");
      },
      requestExit() {},
    },
    {
      appKey: "registered-test",
      webRuntime: "host",
      load() {
        AppRegistry.registerComponent(
          "registered-test",
          () =>
            ({ title }: { title: string }) =>
              createElement(Text, {}, title),
        );
      },
      initialProps: { title: "Registered application" },
    },
  );
  await app.whenCommitted();
  expect(
    [...scene.nodes.values()].some((node) => node.fields.text === "Registered application"),
  ).toBe(true);
  await app.dispose();
  await app.dispose();
  expect(scene.nodes.size).toBe(1);
  expect(scene.listenerCount).toBe(0);
  AppRegistry.unregisterComponent("registered-test");
});
it("cleans up a registration failure", () => {
  const scene = new RecordingSceneGraph();
  expect(() =>
    mountRegisteredApplication(
      {
        scene,
        system: new NativeSystemState(),
        viewport: { width: 640, height: 360 },
        text: {
          prepare() {},
          metrics: () => ({ lineHeight: 20, width: () => 20 }),
        },
        textRaster: {
          dispose() {},
          async acquire() {
            throw Error("unexpected");
          },
        },
        webTransport: async () => {
          throw Error("unexpected");
        },
        requestExit() {},
      },
      { appKey: "missing", webRuntime: "host", load() {} },
    ),
  ).toThrow("has not been registered");
  expect(scene.nodes.size).toBe(1);
  expect(scene.listenerCount).toBe(0);
});
