import { afterEach, expect, it, vi } from "vitest";
import type { RokuHostContext, MountedRokuApplication } from "../host/host.types";
const sdk = vi.hoisted(() => ({
  mounts: [] as Array<() => void>,
  cleanups: [] as Array<() => void>,
  textDisposed: vi.fn(),
  rasterDisposed: vi.fn(),
  factsDisposed: vi.fn(),
  serviceGate: undefined as Promise<void> | undefined,
  factsGate: undefined as Promise<{ timeZone?: string }> | undefined,
  effects: [] as Array<() => void>,
  suspend: undefined as object | undefined,
  resume: undefined as object | undefined,
  completeSuspend: vi.fn(),
  completeResume: vi.fn(),
  setProperty: vi.fn(),
  keyHandlers: [] as Array<{ onKeyEvent(event: { key: string; press: boolean }): void }>,
}));
vi.mock("@roku-sdk/components", () => ({
  KeyHandler: (options: (typeof sdk.keyHandlers)[number]) => {
    sdk.keyHandlers.push(options);
    return options;
  },
}));
vi.mock("@roku-sdk/common/transaction", () => ({ transactionManager: { startTransaction() {} } }));
vi.mock("@roku-sdk/solid", () => ({
  createElement: (type: string) => ({ t: type, c: [] }),
  createEffect: (callback: () => void) => {
    sdk.effects.push(callback);
    callback();
  },
  onMount: (callback: () => void) => sdk.mounts.push(callback),
  onCleanup: (callback: () => void) => sdk.cleanups.push(callback),
  tmTransaction: {
    insertNode(parent: { c: unknown[] }, child: unknown) {
      parent.c.push(child);
    },
    setProperty: sdk.setProperty,
  },
}));
vi.mock("@roku-sdk/runtime/lifecycle", () => ({
  useLifecycle: () => ({
    suspendParams: () => sdk.suspend,
    resumeParams: () => sdk.resume,
    completeSuspend: sdk.completeSuspend,
    completeResume: sdk.completeResume,
  }),
}));
vi.mock("@roku-sdk/runtime/audio-guide", () => ({ getAudioGuide: () => ({ say() {} }) }));
vi.mock("@roku-sdk/runtime/device-info", () => ({ getDeviceInfo: () => null }));
vi.mock("@roku-sdk/runtime/app-memory-monitor", () => ({ getAppMemoryMonitor: vi.fn() }));
vi.mock("./SdkDeviceServices", () => ({
  createSdkDeviceServices: async () => {
    await sdk.serviceGate;
    return {
      storage: { read: async () => null, write: async () => {} },
      randomUUID: () => "fixture",
      randomBytes: (size: number) => new Uint8Array(size),
    };
  },
}));
vi.mock("./SdkDeviceFacts", () => ({
  SdkDeviceFacts: class {
    probe() {
      return sdk.factsGate ?? Promise.resolve({ timeZone: "US/Eastern" });
    }
    dispose() {
      sdk.factsDisposed();
    }
  },
}));
vi.mock("./SdkTextMetrics", () => ({
  SdkTextMetrics: class {
    dispose() {
      sdk.textDisposed();
    }
  },
}));
vi.mock("../graphics/TextRasterCache", () => ({
  TextRasterCache: class {
    dispose() {
      sdk.rasterDisposed();
    }
  },
}));
import { createRokuHost } from "./createRokuHost";

afterEach(async () => {
  for (const cleanup of sdk.cleanups) cleanup();
  await Promise.resolve();
  sdk.mounts.length = 0;
  sdk.cleanups.length = 0;
  sdk.effects.length = 0;
  sdk.keyHandlers.length = 0;
  sdk.serviceGate = undefined;
  sdk.factsGate = undefined;
  sdk.suspend = undefined;
  sdk.resume = undefined;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
function boot(
  whenCommitted: Promise<void>,
  behavior: {
    mountError?: Error;
    publishSystem?: MountedRokuApplication["publishSystem"];
    remote?: MountedRokuApplication["remote"];
  } = {},
) {
  const fetch = vi.fn(),
    abort = vi.fn(() => {
      throw Error("Documented SDK AbortController deviation");
    });
  vi.stubGlobal("fetch", fetch); // No isFeatureSupported/apiVersion, as documented by Roku.
  vi.stubGlobal("Request", class {});
  vi.stubGlobal("AbortController", abort);
  const ready = vi.fn(),
    error = vi.fn(),
    dispose = vi.fn(async () => {}),
    remote = vi.fn(behavior.remote ?? (() => false)),
    publishSystem = vi.fn(behavior.publishSystem ?? (() => {}));
  const mount = vi.fn((_context: RokuHostContext): MountedRokuApplication => {
    if (behavior.mountError) throw behavior.mountError;
    return { whenCommitted: () => whenCommitted, remote, publishSystem, dispose };
  });
  createRokuHost({
    components: {
      AppControl: "RNRAppControl",
      TextRaster: "RNRTextRaster",
      TextRasterTask: "RNRTextRasterTask",
      DeviceFacts: "RNRDeviceFacts",
      DeviceFactsTask: "RNRDeviceFactsTask",
    },
    fonts: { defaultFamily: "Fixture", assets: { Fixture: "pkg:/font.ttf" } },
    viewport: { width: 1920, height: 1080 },
    mount,
    onReady: ready,
    onError: error,
  });
  for (const run of sdk.mounts) run();
  return { ready, error, dispose, mount, fetch, abort, remote, publishSystem };
}
it("boots an offline SDK host with the documented firmware globals and waits for the application commit", async () => {
  let commit!: () => void;
  const state = boot(
    new Promise((resolve) => {
      commit = resolve;
    }),
  );
  await vi.waitFor(() => {
    expect(state.error.mock.calls).toEqual([]);
    expect(state.mount).toHaveBeenCalledOnce();
  });
  expect(typeof state.mount.mock.calls[0][0].webTransport).toBe("function");
  expect(state.mount.mock.calls[0][0].system.getSnapshot().timeZone).toBe("US/Eastern");
  expect(state.ready).not.toHaveBeenCalled();
  commit();
  await vi.waitFor(() => expect(state.ready).toHaveBeenCalledOnce());
  expect(state.error).not.toHaveBeenCalled();
  expect(state.fetch).not.toHaveBeenCalled();
  expect(state.abort).not.toHaveBeenCalled();
  for (const cleanup of sdk.cleanups) {
    cleanup();
    cleanup();
  }
  await vi.waitFor(() => expect(sdk.factsDisposed).toHaveBeenCalledOnce());
  expect(state.dispose).toHaveBeenCalledOnce();
  expect(sdk.textDisposed).toHaveBeenCalledOnce();
  expect(sdk.rasterDisposed).toHaveBeenCalledOnce();
});
it("does not mount after shutdown while initial device observations are pending", async () => {
  let finish!: (value: { timeZone: string }) => void;
  sdk.factsGate = new Promise((resolve) => {
    finish = resolve;
  });
  const state = boot(Promise.resolve());
  await Promise.resolve();
  await Promise.resolve();
  expect(state.mount).not.toHaveBeenCalled();
  for (const cleanup of sdk.cleanups) cleanup();
  finish({ timeZone: "US/Eastern" });
  await vi.waitFor(() => expect(sdk.factsDisposed).toHaveBeenCalledOnce());
  expect(state.mount).not.toHaveBeenCalled();
  expect(state.error).not.toHaveBeenCalled();
});
it("a retired SDK host cannot publish ready after a late application commit", async () => {
  let commit!: () => void;
  const state = boot(
    new Promise((resolve) => {
      commit = resolve;
    }),
  );
  await vi.waitFor(() => expect(state.mount).toHaveBeenCalledOnce());
  for (const cleanup of sdk.cleanups) cleanup();
  commit();
  await vi.waitFor(() => expect(sdk.factsDisposed).toHaveBeenCalledOnce());
  expect(state.ready).not.toHaveBeenCalled();
  expect(state.dispose).toHaveBeenCalledOnce();
});

it("shutdown during pending native services never mounts or allocates application resources", async () => {
  let release!: () => void;
  sdk.serviceGate = new Promise((resolve) => {
    release = resolve;
  });
  const state = boot(Promise.resolve());
  for (const cleanup of sdk.cleanups) cleanup();
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(state.mount).not.toHaveBeenCalled();
  expect(state.ready).not.toHaveBeenCalled();
  expect(state.error).not.toHaveBeenCalled();
  expect(sdk.textDisposed).not.toHaveBeenCalled();
  expect(sdk.rasterDisposed).not.toHaveBeenCalled();
  expect(sdk.factsDisposed).toHaveBeenCalledOnce();
});

it("failed mounting retires allocated native resources and reports startup", async () => {
  const failure = Error("mount failed");
  const state = boot(Promise.resolve(), { mountError: failure });
  await vi.waitFor(() => expect(state.error).toHaveBeenCalledWith(failure, "startup"));
  expect(state.ready).not.toHaveBeenCalled();
  expect(state.dispose).not.toHaveBeenCalled();
  expect(sdk.textDisposed).toHaveBeenCalledOnce();
  expect(sdk.rasterDisposed).toHaveBeenCalledOnce();
  expect(sdk.factsDisposed).toHaveBeenCalledOnce();
});

it("a late commit rejection after shutdown is silent and cannot dispose twice", async () => {
  let reject!: (error: Error) => void;
  const state = boot(
    new Promise((_resolve, fail) => {
      reject = fail;
    }),
  );
  await vi.waitFor(() => expect(state.mount).toHaveBeenCalledOnce());
  for (const cleanup of sdk.cleanups) {
    cleanup();
    cleanup();
  }
  reject(Error("retired commit"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(state.ready).not.toHaveBeenCalled();
  expect(state.error).not.toHaveBeenCalled();
  expect(state.dispose).toHaveBeenCalledOnce();
  expect(sdk.factsDisposed).toHaveBeenCalledOnce();
});

it("lifecycle publication resets repeated key phases and completes native acknowledgements", async () => {
  const state = boot(Promise.resolve());
  await vi.waitFor(() => expect(state.ready).toHaveBeenCalledOnce());
  const key = sdk.keyHandlers[0].onKeyEvent;
  key({ key: "right", press: true });
  key({ key: "right", press: true });
  sdk.suspend = {};
  for (const effect of sdk.effects) effect();
  sdk.suspend = undefined;
  sdk.resume = {};
  for (const effect of sdk.effects) effect();
  key({ key: "right", press: true });
  await Promise.resolve();
  expect(state.remote.mock.calls.map(([event]) => event.phase)).toEqual(["down", "repeat", "down"]);
  expect(state.publishSystem).toHaveBeenCalledWith({ appState: "background" });
  expect(state.publishSystem).toHaveBeenCalledWith({ appState: "active" });
  expect(sdk.completeSuspend).toHaveBeenCalledOnce();
  expect(sdk.completeResume).toHaveBeenCalledOnce();
});

it("handled Back stays in the app, unhandled Back down exits, and retired keys do nothing", async () => {
  const state = boot(Promise.resolve(), { remote: () => true });
  await vi.waitFor(() => expect(state.ready).toHaveBeenCalledOnce());
  const key = sdk.keyHandlers[0].onKeyEvent;
  key({ key: "back", press: true });
  key({ key: "back", press: false });
  expect(sdk.setProperty).not.toHaveBeenCalledWith(expect.anything(), "exitRequested", true);
  state.remote.mockReturnValue(false);
  key({ key: "back", press: true });
  key({ key: "back", press: true });
  key({ key: "back", press: false });
  expect(sdk.setProperty.mock.calls.filter(([, field]) => field === "exitRequested")).toHaveLength(
    1,
  );
  for (const cleanup of sdk.cleanups) cleanup();
  state.remote.mockClear();
  key({ key: "back", press: true });
  expect(state.remote).not.toHaveBeenCalled();
});

it("publication failures still retire every native resource and report disposal once", async () => {
  const failure = Error("publication failed");
  const state = boot(Promise.resolve(), {
    publishSystem: () => {
      throw failure;
    },
  });
  await vi.waitFor(() => expect(state.ready).toHaveBeenCalledOnce());
  sdk.cleanups[0]();
  await vi.waitFor(() => expect(state.error).toHaveBeenCalledWith(failure, "dispose"));
  expect(state.dispose).toHaveBeenCalledOnce();
  expect(sdk.textDisposed).toHaveBeenCalledOnce();
  expect(sdk.rasterDisposed).toHaveBeenCalledOnce();
  expect(sdk.factsDisposed).toHaveBeenCalledOnce();
});

it.each(["publication", "application", "font"] as const)(
  "preserves the first %s shutdown failure when later native cleanup also fails",
  async (phase) => {
    const primary = Error("First " + phase + " failure"),
      later = Error("Later native cleanup failure");
    const state = boot(
      Promise.resolve(),
      phase === "publication"
        ? {
            publishSystem: () => {
              throw primary;
            },
          }
        : {},
    );
    await vi.waitFor(() => expect(state.ready).toHaveBeenCalledOnce());
    if (phase !== "font")
      state.dispose.mockRejectedValueOnce(phase === "application" ? primary : later);
    sdk.textDisposed.mockImplementationOnce(() => {
      throw phase === "font" ? primary : later;
    });
    sdk.rasterDisposed.mockImplementationOnce(() => {
      throw later;
    });
    sdk.factsDisposed.mockImplementationOnce(() => {
      throw later;
    });
    sdk.cleanups[0]();
    await vi.waitFor(() => expect(state.error).toHaveBeenCalledWith(primary, "dispose"));
    expect(state.dispose).toHaveBeenCalledOnce();
    expect(sdk.textDisposed).toHaveBeenCalledOnce();
    expect(sdk.rasterDisposed).toHaveBeenCalledOnce();
    expect(sdk.factsDisposed).toHaveBeenCalledOnce();
  },
);
