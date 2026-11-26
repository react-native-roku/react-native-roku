import { createElement } from "react";
import { expect, it, vi } from "vitest";
import {
  mountApplication,
  mountRegisteredApplication,
  type RokuApplicationContext,
} from "./mountApplication";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import { NativeSystemState } from "../react-native/NativeSystemState";
import { installWebRuntime } from "../services/installWebRuntime";
import { Pressable, Text } from "../react-native/primitives";
import { NativeInput } from "../react-native/NativeInput";

function fixture(system = new NativeSystemState({ appState: "active" })) {
  const scene = new RecordingSceneGraph();
  const disposeText = vi.fn(),
    disposeRaster = vi.fn();
  const context: RokuApplicationContext = {
    scene,
    system,
    viewport: { width: 640, height: 360 },
    text: {
      prepare() {},
      metrics: () => ({ lineHeight: 20, width: (value) => value.length * 8 }),
      dispose: disposeText,
    },
    textRaster: {
      dispose: disposeRaster,
      async acquire() {
        throw Error("unexpected raster");
      },
    },
    onError() {},
  };
  return { context, scene, system, disposeText, disposeRaster };
}

it("preserves a registration failure while attempting independent cleanup", () => {
  const original = Error("entry failed"),
    disposeText = vi.fn(() => {
      throw Error("text cleanup");
    });
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
          dispose: disposeText,
        },
        textRaster: {
          dispose: vi.fn(),
          async acquire() {
            throw Error("unexpected");
          },
        },
        webTransport: async () => {
          throw Error("unexpected");
        },
        requestExit() {},
      },
      {
        appKey: "failed-lifetime",
        load() {
          throw original;
        },
      },
    ),
  ).toThrow(original);
  expect(disposeText).toHaveBeenCalledOnce();
  expect(scene.listenerCount).toBe(0);
});

it("retires web leases out of order without clearing or resurrecting another host", () => {
  const target = { fetch: vi.fn() } as Record<string, unknown>;
  const original = target.fetch;
  const first = installWebRuntime(
    async () => ({ status: 200, headers: {}, body: "first" }),
    target,
  );
  const second = installWebRuntime(
    async () => ({ status: 200, headers: {}, body: "second" }),
    target,
  );
  const current = target.fetch;
  first();
  expect(target.fetch).toBe(current);
  first();
  second();
  expect(target.fetch).toBe(original);
  expect(Object.keys(target)).toEqual(["fetch"]);
});

it("keeps successor web leases owned after repeating an earlier generation's release", () => {
  const target: Record<string, unknown> = { fetch: vi.fn(), URL: vi.fn() };
  const original = Object.getOwnPropertyDescriptors(target);
  const retired = installWebRuntime(undefined, target);
  retired();
  const older = installWebRuntime(
    async () => ({ status: 200, headers: {}, body: "older" }),
    target,
  );
  retired();
  const newer = installWebRuntime(
    async () => ({ status: 200, headers: {}, body: "newer" }),
    target,
  );
  try {
    const active = Object.getOwnPropertyDescriptors(target);
    older();
    expect(Object.getOwnPropertyDescriptors(target)).toEqual(active);
    newer();
    expect(Object.getOwnPropertyDescriptors(target)).toEqual(original);
  } finally {
    retired();
    older();
    newer();
  }
});

it("retries failed web cleanup without repeating successful releases", () => {
  const originalFetch = vi.fn(),
    failure = Error("restore refused");
  let refuseRestore = false;
  const target = new Proxy<Record<string, unknown>>(
    { fetch: originalFetch },
    {
      defineProperty(object, key, descriptor) {
        if (refuseRestore && key === "fetch" && descriptor.value === originalFetch) throw failure;
        return Reflect.defineProperty(object, key, descriptor);
      },
    },
  );
  const release = installWebRuntime(
    async () => ({ status: 200, headers: {}, body: "owned" }),
    target,
  );
  try {
    refuseRestore = true;
    expect(release).toThrow(failure);
    expect(target.fetch).not.toBe(originalFetch);
    expect(Reflect.ownKeys(target)).toEqual(["fetch"]);
    refuseRestore = false;
    release();
    expect(target.fetch).toBe(originalFetch);
    const successor = installWebRuntime(undefined, target);
    try {
      const active = Object.getOwnPropertyDescriptors(target);
      release();
      expect(Object.getOwnPropertyDescriptors(target)).toEqual(active);
    } finally {
      successor();
    }
  } finally {
    refuseRestore = false;
    release();
  }
});

it("mounts lazy content after setup, dispatches observed input and publishes system state", async () => {
  const f = fixture(),
    pressed = vi.fn(),
    order: string[] = [];
  const app = mountApplication(f.context, {
    webRuntime: "host",
    setup() {
      order.push("setup");
      return () => order.push("release");
    },
    createContent() {
      order.push("content");
      return {
        element: createElement(
          Pressable,
          { nativeID: "button", onPress: pressed },
          createElement(Text, {}, "Ready"),
        ),
      };
    },
  });
  await app.whenCommitted();
  expect(order).toEqual(["setup", "content"]);
  const node = [...f.scene.nodes.values()].find((node) => node.fields.id === "button")!;
  f.scene.emit(node, "focusedChild", "button");
  app.remote({ key: "select", phase: "down" });
  app.remote({ key: "select", phase: "up" });
  expect(pressed).toHaveBeenCalledOnce();
  app.publishSystem({ appState: "background" });
  expect(f.system.getSnapshot().appState).toBe("background");
  await app.dispose();
  app.publishSystem({ appState: "active" });
  expect(f.system.getSnapshot().appState).toBe("background");
  expect(app.remote({ key: "select", phase: "down" })).toBe(false);
  expect(app.input.targetCount + app.input.observerCount).toBe(0);
  expect(f.scene.nodes.size).toBe(1);
  expect(f.scene.listenerCount).toBe(0);
  expect(order).toEqual(["setup", "content", "release"]);
});

it.each(["setup", "content", "render"] as const)(
  "preserves %s failure and retires allocated owners",
  async (stage) => {
    const f = fixture(),
      original = Error(`${stage} failed`),
      cleanup = vi.fn();
    const fail = () => {
      throw original;
    };
    expect(() =>
      mountApplication(f.context, {
        webRuntime: "host",
        setup: stage === "setup" ? fail : () => cleanup,
        createContent:
          stage === "content"
            ? fail
            : () => ({
                element: stage === "render" ? createElement(fail) : null,
                dispose: cleanup,
              }),
      }),
    ).toThrow(original);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.disposeText).toHaveBeenCalledOnce();
    expect(f.disposeRaster).toHaveBeenCalledOnce();
    expect(f.scene.nodes.size).toBe(1);
    expect(f.scene.listenerCount).toBe(0);
    expect(cleanup).toHaveBeenCalledTimes(stage === "setup" ? 0 : stage === "content" ? 1 : 2);
  },
);

it("disposes input on root allocation failure and leaves the next root usable", async () => {
  const f = fixture(),
    inputDispose = vi.spyOn(NativeInput.prototype, "dispose");
  try {
    expect(() =>
      mountApplication(
        { ...f.context, viewport: { width: 0, height: 360 } },
        {
          createContent: () => ({ element: null }),
        },
      ),
    ).toThrow("viewport");
    expect(inputDispose).toHaveBeenCalledOnce();
    const next = mountApplication(f.context, {
      webRuntime: "host",
      createContent: () => ({ element: createElement(Text, {}, "Next") }),
    });
    await next.whenCommitted();
    await next.dispose();
  } finally {
    inputDispose.mockRestore();
  }
});

it("shares one reentrant asynchronous disposal and attempts every release after rejection", async () => {
  const f = fixture(),
    original = Error("text cleanup failed"),
    secondary = Error("consumer failed");
  f.disposeText.mockImplementation(() => {
    throw original;
  });
  const release = vi.fn(() => {
    throw Error("setup cleanup failed");
  });
  let reject!: (error: Error) => void, reentrant: Promise<void> | undefined;
  const consumer = vi.fn(() => {
    reentrant = app.dispose();
    return new Promise<void>((_, fail) => {
      reject = fail;
    });
  });
  const previous = globalThis.fetch;
  const app = mountApplication(f.context, {
    setup: () => release,
    createContent: () => ({ element: null, dispose: consumer }),
  });
  const first = app.dispose();
  expect(reentrant).toBe(first);
  expect(app.dispose()).toBe(first);
  expect(consumer).toHaveBeenCalledOnce();
  expect(f.disposeRaster).toHaveBeenCalledOnce();
  reject(secondary);
  await expect(first).rejects.toBe(original);
  expect(release).toHaveBeenCalledOnce();
  expect(globalThis.fetch).toBe(previous);
  expect(app.dispose()).toBe(first);
});

it("cannot clear a successor's globals when older async content finishes later", async () => {
  const system = new NativeSystemState({ appState: "active" }),
    first = fixture(system),
    second = fixture(system);
  const previous = globalThis.fetch;
  let finish!: () => void;
  const older = mountApplication(
    { ...first.context, webTransport: async () => ({ status: 200, headers: {}, body: "old" }) },
    {
      createContent: () => ({
        element: null,
        dispose: () =>
          new Promise<void>((done) => {
            finish = done;
          }),
      }),
    },
  );
  const disposal = older.dispose();
  const newer = mountApplication(
    { ...second.context, webTransport: async () => ({ status: 200, headers: {}, body: "new" }) },
    {
      createContent: () => ({ element: createElement(Text, {}, "New") }),
    },
  );
  const current = globalThis.fetch;
  finish();
  await disposal;
  expect(globalThis.fetch).toBe(current);
  expect(await (await fetch("https://fixture.invalid/text")).text()).toBe("new");
  older.publishSystem({ appState: "background" });
  expect(system.getSnapshot().appState).toBe("active");
  await newer.whenCommitted();
  await newer.dispose();
  expect(globalThis.fetch).toBe(previous);
});

it("supports overlapping roots sharing environment ports and out-of-order retirement", async () => {
  const system = new NativeSystemState(),
    first = fixture(system),
    second = fixture(system);
  const a = mountApplication(first.context, {
    createContent: () => ({ element: createElement(Text, {}, "A") }),
  });
  const b = mountApplication(second.context, {
    createContent: () => ({ element: createElement(Text, {}, "B") }),
  });
  await a.whenCommitted();
  await b.whenCommitted();
  await a.dispose();
  b.publishSystem({ appState: "active" });
  expect(second.scene.nodes.size).toBeGreaterThan(1);
  await b.dispose();
  expect(first.scene.nodes.size + second.scene.nodes.size).toBe(2);
});

it("rolls back partially installed web globals if a host property refuses replacement", () => {
  const previous = vi.fn(),
    target: Record<string, unknown> = { URL: previous };
  Object.defineProperty(target, "Headers", { value: "fixed", configurable: false });
  expect(() => installWebRuntime(undefined, target)).toThrow(TypeError);
  expect(target.URL).toBe(previous);
  expect(Object.hasOwn(target, "URLSearchParams")).toBe(false);
  expect(target.Headers).toBe("fixed");
});

it("fences late text preparation while a successor root commits", async () => {
  const system = new NativeSystemState(),
    first = fixture(system),
    second = fixture(system);
  let ready!: () => void;
  const older = mountApplication(
    {
      ...first.context,
      text: {
        ...first.context.text,
        prepare: () =>
          new Promise<void>((done) => {
            ready = done;
          }),
      },
    },
    {
      webRuntime: "host",
      createContent: () => ({ element: createElement(Text, {}, "Old pending text") }),
    },
  );
  const pending = older.whenCommitted().catch(() => undefined);
  await older.dispose();
  const newer = mountApplication(second.context, {
    webRuntime: "host",
    createContent: () => ({ element: createElement(Text, {}, "New committed text") }),
  });
  ready();
  await pending;
  await newer.whenCommitted();
  expect(first.scene.nodes.size).toBe(1);
  expect(
    [...second.scene.nodes.values()].some((node) => node.fields.text === "New committed text"),
  ).toBe(true);
  await newer.dispose();
});

it("releases content, setup and globals after an input disposal failure", async () => {
  const f = fixture(),
    primary = Error("input disposal"),
    consumer = vi.fn(),
    release = vi.fn();
  const previous = globalThis.Headers;
  const app = mountApplication(f.context, {
    setup: () => release,
    createContent: () => ({ element: null, dispose: consumer }),
  });
  const disposeInput = app.input.dispose.bind(app.input);
  vi.spyOn(app.input, "dispose").mockImplementation(() => {
    disposeInput();
    throw primary;
  });
  await expect(app.dispose()).rejects.toBe(primary);
  expect(consumer).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
  expect(globalThis.Headers).toBe(previous);
});

it("retires setup subscriptions before old asynchronous content can overlap a new root", async () => {
  const first = fixture(),
    second = fixture();
  let selected = "old",
    finish!: () => void;
  const older = mountApplication(first.context, {
    webRuntime: "host",
    setup: () =>
      first.system.subscribe(() => {
        selected = "retired callback";
      }),
    createContent: () => ({
      element: null,
      dispose: () =>
        new Promise<void>((done) => {
          finish = done;
        }),
    }),
  });
  const pending = older.dispose();
  const newer = mountApplication(second.context, {
    webRuntime: "host",
    setup() {
      selected = "new";
    },
    createContent: () => ({ element: null }),
  });
  try {
    first.system.publish({ timeZone: "America/Chicago" });
    expect(selected).toBe("new");
  } finally {
    finish();
    await pending;
    await newer.dispose();
  }
});
