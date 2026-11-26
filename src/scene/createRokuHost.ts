import { KeyHandler } from "@roku-sdk/components";
import {
  createElement,
  createEffect,
  onCleanup,
  onMount,
  tmTransaction,
  type JSX,
} from "@roku-sdk/solid";
import { useLifecycle } from "@roku-sdk/runtime/lifecycle";
import { getAudioGuide } from "@roku-sdk/runtime/audio-guide";
import { getDeviceInfo } from "@roku-sdk/runtime/device-info";
import { getAppMemoryMonitor } from "@roku-sdk/runtime/app-memory-monitor";
import { SdkDeviceFacts } from "./SdkDeviceFacts";
import { SdkSceneGraph } from "./SdkSceneGraph";
import { SdkTextMetrics } from "./SdkTextMetrics";
import { SdkTextRasterTransport } from "./SdkTextRasterTransport";
import { createSdkDeviceServices } from "./SdkDeviceServices";
import { createSdkWebTransport } from "./SdkWebTransport";
import { SdkTextEntry } from "./SdkTextEntry";
import { TextRasterCache } from "../graphics/TextRasterCache";
import { RokuKeySession } from "../services/RokuKeySession";
import { NativeSystemState, type SystemSnapshot } from "../react-native/NativeSystemState";

export type {
  RokuHostOptions,
  RokuHostContext,
  MountedRokuApplication,
  RokuHostPhase,
  RokuMemorySnapshot,
} from "../host/host.types";
import type { RokuHostOptions, MountedRokuApplication, RokuHostPhase } from "../host/host.types";

/** Call inside an SDK defineAnchorNode callback. The consumer keeps its literal
 * anchor/Scene names, application composition and packaged asset configuration. */
export function createRokuHost(options: RokuHostOptions): JSX.Element {
  const names = options.components;
  if (
    names.TextRasterTask !== "RNRTextRasterTask" ||
    names.DeviceFactsTask !== "RNRDeviceFactsTask"
  )
    throw Error("Native task registration differs from the react-native-roku contract");
  if (!(
    options.viewport.width > 0 &&
    Number.isFinite(options.viewport.width) &&
    options.viewport.height > 0 &&
    Number.isFinite(options.viewport.height)
  ))
    throw Error("The Roku viewport must have finite positive dimensions");
  const container = createElement("group"),
    wrapper = createElement("group");
  const control = createElement(names.AppControl),
    raster = createElement(names.TextRaster),
    facts = createElement(names.DeviceFacts);
  const scene = new SdkSceneGraph(container, control),
    keys = new RokuKeySession();
  const textEntry = new SdkTextEntry(control);
  const system = new NativeSystemState({}, (message, options) =>
    getAudioGuide().say(message, options?.queue !== true, true),
  );
  const lifecycle = useLifecycle();
  let application: MountedRokuApplication | undefined,
    disposed = false,
    disposal: Promise<void> | undefined;
  let text: SdkTextMetrics | undefined, textRaster: TextRasterCache | undefined;
  const report = (error: unknown, phase: RokuHostPhase) => {
    const value = error instanceof Error ? error : Error(String(error));
    if (options.onError) options.onError(value, phase);
    else console.error("ROKU_HOST_ERROR", phase, value.message);
  };
  const publish = (snapshot: Partial<SystemSnapshot>) => {
    if (snapshot.appState && snapshot.appState !== "active") keys.reset();
    if (snapshot.appState && snapshot.appState !== "active") textEntry.dismiss();
    if (application) application.publishSystem(snapshot);
    else system.publish(snapshot);
  };
  const deviceFacts = new SdkDeviceFacts(facts, publish, (level) => {
    if (level && level.toLowerCase() !== "normal") system.publishMemoryWarning();
  });
  for (const [params, state, complete] of [
    [() => lifecycle.suspendParams(), "background", () => lifecycle.completeSuspend()],
    [() => lifecycle.resumeParams(), "active", () => lifecycle.completeResume()],
  ] as const)
    createEffect(() => {
      if (!params() || disposed) return;
      keys.reset();
      publish({ appState: state });
      // Complete after the SDK's queued Tree transaction has submitted.
      void Promise.resolve().then(complete);
    });
  scene.batch(() => {
    for (const node of [control, raster, facts, container]) tmTransaction.insertNode(wrapper, node);
  });
  const requestExit = () => {
    if (!disposed) scene.batch(() => tmTransaction.setProperty(control, "exitRequested", true));
  };
  const dispose = () =>
    (disposal ??= (async () => {
      disposed = true;
      const failures: unknown[] = [];
      const attempt = (work: () => void) => {
        try {
          work();
        } catch (error) {
          failures.push(error);
        }
      };
      attempt(() => keys.reset());
      attempt(() => publish({ appState: "inactive" }));
      try {
        await application?.dispose();
      } catch (error) {
        failures.push(error);
      }
      attempt(() => scene.cancelFocusSample());
      attempt(() => text?.dispose());
      attempt(() => textRaster?.dispose());
      attempt(() => deviceFacts.dispose());
      attempt(() => textEntry.dispose());
      if (failures.length) throw failures[0];
    })());
  onMount(() => {
    void createSdkDeviceServices({ namespace: options.storageNamespace })
      .then(async (services) => {
        if (disposed) return;
        const device = getDeviceInfo();
        try {
          const facts = await deviceFacts.probe({ video: [], audio: [] });
          if (disposed) return;
          const timeZone = (facts as { timeZone?: unknown } | null)?.timeZone;
          if (typeof timeZone === "string" && timeZone.trim()) system.publish({ timeZone });
        } catch (error) {
          if (disposed) return;
          report(error, "device-facts");
        }
        if (system.getSnapshot().appState === null) system.publish({ appState: "active" });
        text = new SdkTextMetrics(scene, options.fonts);
        textRaster = new TextRasterCache(
          new SdkTextRasterTransport(raster, options.fonts.assets, services.randomUUID()),
        );
        application = options.mount({
          scene,
          system,
          text,
          textRaster,
          services: { ...services, nativeCapabilities: deviceFacts, textEntry },
          webTransport: createSdkWebTransport(),
          svgAtlas: options.svgAtlas,
          requestExit,
          platformVersion: device
            ? `${device.osVersion.major}.${device.osVersion.minor}`
            : undefined,
          graphics: {
            effects:
              Number(device?.osVersion.major ?? 0) >= 16 && device?.graphicsPlatform === "opengl",
            composedMasks: device?.graphicsPlatform === "opengl",
            cornerMasks: device?.graphicsPlatform === "opengl" ? options.cornerMasks : undefined,
          },
          viewport: options.viewport,
        });
        await application.whenCommitted();
        if (disposed) return;
        await options.onReady?.({
          device: device
            ? {
                model: device.model,
                osVersion: { ...device.osVersion },
                graphicsPlatform: device.graphicsPlatform,
              }
            : null,
        });
        if (options.onMemorySnapshot && !disposed)
          void getAppMemoryMonitor()
            .then((monitor) => {
              if (disposed) return;
              options.onMemorySnapshot?.({
                availableKb: monitor.getChannelAvailableMemory(),
                usagePercent: monitor.getMemoryLimitPercent(),
                limits: monitor.getChannelMemoryLimit(),
                hermesHeap: monitor.getTSHeapInfo(),
              });
            })
            .catch((error) => {
              if (!disposed) report(error, "memory");
            });
      })
      .catch(async (error) => {
        if (!disposed) {
          try {
            await dispose();
          } catch (cleanupError) {
            report(cleanupError, "dispose");
          }
          report(error, "startup");
        }
      });
  });
  onCleanup(() => {
    void dispose().catch((error) => report(error, "dispose"));
  });
  return KeyHandler({
    handleAllKeys: true,
    children: wrapper as unknown as JSX.Element,
    onKeyEvent(event) {
      if (disposed) return;
      keys.handle(event.key, event.press, (intent) => {
        const handled = application?.remote(intent) ?? false;
        if (!handled && intent.key === "back" && intent.phase === "down") requestExit();
        return handled;
      });
    },
  });
}
