import { createElement, Fragment } from "react";
import { expect, it, vi } from "vitest";
import { createNativeRoot } from "./createNativeRoot";
import { Text } from "./primitives";
import { NativeInput } from "./NativeInput";
import { NativeSystemState } from "./NativeSystemState";
import { TextRasterCache } from "../graphics/TextRasterCache";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";

const element = (value: string) =>
  createElement(Text, { style: { width: 100, height: 20, letterSpacing: 1 } }, value);
function fixture() {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput(),
    system = new NativeSystemState({ appState: "active" });
  const fontError = Error("Font provider cleanup failed"),
    rasterError = Error("Raster transport cleanup failed");
  const state = {
    fontFailures: 0,
    rasterFailures: 0,
    maskFailure: undefined as Error | undefined,
    onTextDispose: undefined as (() => void) | undefined,
  };
  const textDispose = vi.fn(() => {
    state.onTextDispose?.();
    if (state.fontFailures > 0) {
      state.fontFailures--;
      throw fontError;
    }
  });
  const transportDispose = vi.fn(() => {
    if (state.rasterFailures > 0) {
      state.rasterFailures--;
      throw rasterError;
    }
  });
  const cache = new TextRasterCache(
    {
      mask: async (spec) => {
        if (state.maskFailure) throw state.maskFailure;
        return new Uint8Array(spec.width * spec.height);
      },
      write: async (name) => "fixture:/" + name,
      delete: async () => {},
      dispose: transportDispose,
    },
    80_000,
  );
  const errors = vi.fn();
  const root = createNativeRoot(scene, {
    input,
    system,
    onError: errors,
    textRaster: cache,
    viewport: { width: 300, height: 100 },
    text: {
      prepare() {},
      metrics: () => ({ lineHeight: 20, width: (value) => value.length * 8 }),
      dispose: textDispose,
    },
  });
  const ready = async () => {
    root.render(element("ready"));
    await root.whenCommitted();
  };
  const check = () => {
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
    expect(input.targetCount).toBe(0);
    expect(input.observerCount).toBe(0);
    expect(system.listenerCount).toBe(0);
    expect(root.mounted).toBe(false);
  };
  return {
    root,
    scene,
    input,
    system,
    cache,
    errors,
    textDispose,
    transportDispose,
    state,
    ready,
    check,
    fontError,
    rasterError,
  };
}

it("retires the actual bounded raster cache and service bindings when font disposal throws", async () => {
  const f = fixture();
  await f.ready();
  expect(f.cache.diagnostics().entries).toBe(1);
  f.state.fontFailures = 1;
  expect(() => f.root.unmount()).toThrow(f.fontError);
  expect(f.transportDispose).toHaveBeenCalledTimes(1);
  expect(f.cache.diagnostics().entries).toBe(0);
  expect(f.cache.diagnostics().leased).toBe(0);
  f.check();
});

it("attempts both provider disposers while preserving the first cleanup failure", async () => {
  const f = fixture();
  await f.ready();
  f.state.fontFailures = f.state.rasterFailures = 1;
  expect(() => f.root.unmount()).toThrow(f.fontError);
  expect(f.transportDispose).toHaveBeenCalledTimes(1);
  f.check();
});

it("preserves a latched render failure ahead of later cleanup failures", async () => {
  const f = fixture(),
    primary = Error("Original mask preparation failed");
  f.state.maskFailure = primary;
  f.root.render(element("failed"));
  await expect(f.root.whenCommitted()).rejects.toBe(primary);
  f.state.fontFailures = 1;
  expect(() => f.root.unmount()).toThrow(primary);
  expect(f.transportDispose).toHaveBeenCalledTimes(1);
  f.check();
});

it("retries only failed provider cleanup while the React/native root stays retired", async () => {
  const f = fixture();
  await f.ready();
  f.state.fontFailures = 1;
  expect(() => f.root.unmount()).toThrow(f.fontError);
  f.root.unmount();
  f.root.unmount();
  expect(f.textDispose).toHaveBeenCalledTimes(2);
  expect(f.transportDispose).toHaveBeenCalledTimes(1);
  f.check();
});

it("does not duplicate provider cleanup during reentrant root retirement", async () => {
  const f = fixture();
  await f.ready();
  f.state.onTextDispose = () => f.root.unmount();
  f.root.unmount();
  expect(f.textDispose).toHaveBeenCalledTimes(1);
  expect(f.transportDispose).toHaveBeenCalledTimes(1);
  f.check();
});

it("retries a failed actual raster transport disposal through the retired root", async () => {
  const f = fixture();
  await f.ready();
  f.state.rasterFailures = 1;
  expect(() => f.root.unmount()).toThrow(f.rasterError);
  f.root.unmount();
  f.root.unmount();
  expect(f.textDispose).toHaveBeenCalledTimes(1);
  expect(f.transportDispose).toHaveBeenCalledTimes(2);
  expect(f.cache.diagnostics()).toEqual({ entries: 0, bytes: 0, pending: 0, leased: 0 });
  f.check();
});

it("attempts later leases and cache disposal after an earlier lease repeatedly refuses release", async () => {
  const scene = new RecordingSceneGraph(),
    failure = Error("First lease cleanup failed");
  let refusals = 2;
  const first = {
    image: { uri: "fixture:/first", width: 100, height: 20, inset: 0 },
    release: vi.fn(() => {
      if (refusals-- > 0) throw failure;
    }),
  };
  const second = {
      image: { uri: "fixture:/second", width: 100, height: 20, inset: 0 },
      release: vi.fn(),
    },
    dispose = vi.fn();
  const root = createNativeRoot(scene, {
    viewport: { width: 300, height: 100 },
    text: { prepare() {}, metrics: () => ({ lineHeight: 20, width: () => 8 }) },
    textRaster: {
      acquire: async (request) => (request.layout.text === "first" ? first : second),
      dispose,
    },
  });
  root.render(createElement(Fragment, {}, element("first"), element("second")));
  await root.whenCommitted();
  expect(() => root.unmount()).toThrow(failure);
  expect(second.release).toHaveBeenCalledTimes(1);
  expect(dispose).toHaveBeenCalledTimes(1);
  root.unmount();
  expect(first.release).toHaveBeenCalledTimes(3);
  expect(second.release).toHaveBeenCalledTimes(1);
  expect(scene.nodes.size).toBe(1);
});
