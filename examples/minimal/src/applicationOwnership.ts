import { createElement } from "react";
import { Text, Pressable } from "react-native";
import { mountApplication } from "react-native-roku/application";
import { RecordingSceneGraph } from "react-native-roku/testing";
import { NativeSystemState } from "react-native-roku/system";
import { createCanvasFontRegistry, observePreviewText } from "react-native-roku/preview";
import { installWebRuntime } from "react-native-roku/web";

/** Independent consumer composition: owns its routes, source files and assets. */
export async function qualifyApplicationOwnership() {
  const demand = (value: unknown, message: string) => {
    if (!value) throw Error(message);
  };
  const target: Record<string, unknown> = { fetch: globalThis.fetch, URL: globalThis.URL };
  const originalFetch = target.fetch,
    originalURL = target.URL;
  const retiredWeb = installWebRuntime(undefined, target);
  retiredWeb();
  const olderWeb = installWebRuntime(
    async () => ({ status: 200, headers: {}, body: "older" }),
    target,
  );
  retiredWeb();
  const newerWeb = installWebRuntime(
    async () => ({ status: 200, headers: {}, body: "newer" }),
    target,
  );
  try {
    const active = Object.getOwnPropertyDescriptors(target);
    olderWeb();
    demand(
      Reflect.ownKeys(active).every((key) => target[key as string] === active[key as string].value),
      "Repeated old web cleanup disturbed a newer host",
    );
    newerWeb();
    demand(
      target.fetch === originalFetch &&
        target.URL === originalURL &&
        Reflect.ownKeys(target).length === 2,
      "Web cleanup restored a retired host instead of the original globals",
    );
  } finally {
    retiredWeb();
    olderWeb();
    newerWeb();
  }
  const scene = new RecordingSceneGraph(),
    system = new NativeSystemState({ appState: "active" });
  let activated = 0,
    cleanups = 0,
    releases = 0;
  const app = mountApplication(
    {
      scene,
      system,
      viewport: { width: 480, height: 270 },
      text: {
        prepare() {},
        metrics: () => ({ lineHeight: 20, width: (value) => value.length * 9 }),
      },
    },
    {
      webRuntime: "host",
      setup: () => () => {
        releases++;
      },
      createContent: () => ({
        element: createElement(
          Pressable,
          {
            nativeID: "consumer-action",
            onPress: () => {
              activated++;
            },
          },
          createElement(Text, {}, "Independent application"),
        ),
        async dispose() {
          cleanups++;
          await Promise.resolve();
        },
      }),
    },
  );
  await app.whenCommitted();
  const button = [...scene.nodes.values()].find((node) => node.fields.id === "consumer-action")!;
  scene.emit(button, "focusedChild", "consumer-action");
  app.remote({ key: "select", phase: "down" });
  app.remote({ key: "select", phase: "up" });
  demand(activated === 1, "Shared lifetime did not dispatch the observed consumer input");
  const disposal = app.dispose();
  demand(releases === 1, "Setup subscriptions outlived application retirement");
  demand(app.dispose() === disposal, "Overlapping consumer disposal was not shared");
  await disposal;
  app.publishSystem({ appState: "background" });
  demand(system.getSnapshot().appState === "active", "Retired consumer published system state");
  demand(
    scene.nodes.size === 1 && scene.listenerCount === 0 && cleanups === 1 && releases === 1,
    "Independent consumer lifetime did not retire",
  );

  const primary = Error("consumer content failed");
  let setupReleased = 0,
    failure: unknown;
  try {
    mountApplication(
      {
        scene,
        system,
        viewport: { width: 480, height: 270 },
        text: {
          prepare() {},
          metrics: () => ({ lineHeight: 20, width: () => 10 }),
          dispose() {
            throw Error("secondary cleanup");
          },
        },
      },
      {
        webRuntime: "host",
        setup: () => () => {
          setupReleased++;
        },
        createContent() {
          throw primary;
        },
      },
    );
  } catch (error) {
    failure = error;
  }
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  demand(
    failure === primary && setupReleased === 1,
    "Startup error or independent cleanup was lost",
  );

  let registrations = 0,
    unregistrations = 0;
  const registry = createCanvasFontRegistry({
    limit: 1,
    register: (uri, family) => ({ uri, family, id: ++registrations }),
    unregister() {
      unregistrations++;
    },
  });
  const first = registry.createOwner(),
    second = registry.createOwner();
  await Promise.all([
    first.ready("fixture:/consumer-font.ttf", "ConsumerBody"),
    second.ready("fixture:/consumer-font.ttf", "ConsumerBody"),
  ]);
  first.dispose();
  registry.retireUnused();
  demand(unregistrations === 0 && registrations === 1, "Shared font lease was released early");
  second.dispose();
  registry.retireUnused();
  demand(
    registry.snapshot().registrations === 0 && unregistrations === 1,
    "Shared font did not retire",
  );

  let finish!: (key: string) => void,
    lateReleased = 0;
  const pendingFonts = createCanvasFontRegistry({
    register: () =>
      new Promise<string>((done) => {
        finish = done;
      }),
    unregister() {
      lateReleased++;
    },
  });
  const owner = pendingFonts.createOwner(),
    ready = owner.ready("fixture:/late-font.ttf", "Late");
  const rejection = ready.then(
    () => false,
    () => true,
  );
  await Promise.resolve();
  owner.dispose();
  finish("late-token");
  demand(await rejection, "A retired font preparation succeeded");
  demand(
    lateReleased === 1 && pendingFonts.snapshot().registrations === 0,
    "Late font registration leaked",
  );

  let releaseRaster = 0,
    resolveRaster!: (lease: import("react-native-roku/text-raster").TextRasterLease) => void;
  const observations = observePreviewText({
    acquire: () =>
      new Promise((done) => {
        resolveRaster = done;
      }),
    dispose() {},
  });
  const text = observations.provider.acquire({
    style: { fontSize: 20 },
    layout: { text: "Retired text", lines: ["Retired text"], width: 10, height: 20 },
    metrics: { lineHeight: 20, width: () => 10 },
    width: 10,
    height: 20,
  });
  observations.provider.dispose();
  resolveRaster({
    image: { uri: "fixture:/consumer-image.png", width: 1, height: 1, inset: 0 },
    release() {
      releaseRaster++;
    },
  });
  (await text).release();
  demand(
    releaseRaster === 1 &&
      observations.snapshot({ fields: { uri: "fixture:/consumer-image.png" }, children: [] })
        .length === 0,
    "Retired raster history affected attached text observations",
  );
  return {
    lifetime: "passed",
    webLeaseGenerations: "passed",
    previewLeases: "passed",
    deviceQualified: false,
  };
}
