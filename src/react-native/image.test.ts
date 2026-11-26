import { createElement, startTransition, Suspense, useState } from "react";
import { describe, expect, it } from "vitest";
import { createNativeRoot } from "./createNativeRoot";
import { Image, registerPackagedImage } from "./image";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";

describe("native Poster image lifecycle", () => {
  it("preserves an authored data URI while resolving its native packaged raster", () => {
    const original = "data:image/png;base64,aGVsbG8=",
      packaged = "pkg:/images/asset-0123456789abcdef01234567.png";
    expect(registerPackagedImage(original, packaged)).toBe(original);
    const scene = new RecordingSceneGraph(),
      root = createNativeRoot(scene, {
        text: {
          prepare() {},
          metrics: () => ({ lineHeight: 20, width: () => 10 }),
        },
        viewport: { width: 800, height: 600 },
      });
    try {
      root.render(
        createElement(Image, {
          source: original,
          style: { width: 20, height: 20 },
        }),
      );
      expect([...scene.nodes.values()].find((node) => node.type === "poster")?.fields.uri).toBe(
        packaged,
      );
      expect(() => registerPackagedImage(original, "file:/outside.png")).toThrow(/registration/);
    } finally {
      root.unmount();
    }
  });
  it("waits for native raster readiness and dimensions, retires recycled callbacks, and reports actual failure", () => {
    class Scene extends RecordingSceneGraph {
      override set(...args: Parameters<RecordingSceneGraph["set"]>) {
        if (args[1] === "uri") expect(this.listenerCount).toBeGreaterThanOrEqual(3);
        super.set(...args);
      }
    }
    const scene = new Scene(),
      events: unknown[] = [];
    const root = createNativeRoot(scene, {
      viewport: { width: 800, height: 600 },
      text: {
        prepare() {},
        metrics: () => ({ lineHeight: 20, width: () => 10 }),
      },
    });
    const render = (uri: string) =>
      root.render(
        createElement(Image, {
          source: { uri },
          style: { width: 300, height: 200 },
          contentFit: "cover",
          onLoad: (event) => events.push(event),
          onDisplay: () => events.push("display"),
          onError: (event) => events.push(event.error),
        }),
      );
    render("https://example.invalid/one.jpg");
    const first = scene.root.children[0].children[0];
    expect(first.fields).toMatchObject({
      uri: "https://example.invalid/one.jpg",
      width: 300,
      height: 200,
      translation: [0, 0],
      loadDisplayMode: "scaleToZoom",
    });
    scene.emit(first, "loadStatus", "ready");
    expect(events).toEqual([]);
    scene.emit(first, "bitmapWidth", 1920);
    scene.emit(first, "bitmapHeight", 1080);
    expect(events).toEqual([
      {
        source: {
          url: "https://example.invalid/one.jpg",
          width: 1920,
          height: 1080,
        },
      },
      "display",
    ]);
    scene.emit(first, "loadStatus", "ready");
    expect(events).toHaveLength(2);
    render("https://example.invalid/two.jpg");
    const second = scene.root.children[0].children[0];
    expect(second.id).not.toBe(first.id);
    scene.emit(first, "loadStatus", "failed");
    expect(events).toHaveLength(2);
    scene.emit(second, "loadStatus", "failed");
    scene.emit(second, "loadStatus", "failed");
    expect(events).toHaveLength(3);
    expect(events[2]).toContain("Native Poster failed");
    root.unmount();
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
  });
  it("does not report cache operations as successful without a native cache capability", async () => {
    expect(await Image.prefetch("https://example.invalid/image.png")).toBe(false);
    expect(await Image.clearMemoryCache()).toBe(false);
    expect(await Image.clearDiskCache()).toBe(false);
  });

  it("delivers the latest callbacks for a retained Poster and ends delivery on source replacement", () => {
    const scene = new RecordingSceneGraph();
    const events: string[] = [];
    const root = createNativeRoot(scene, {
      viewport: { width: 800, height: 600 },
      text: { prepare() {}, metrics: () => ({ lineHeight: 20, width: () => 10 }) },
    });
    const firstSource = "pkg:/images/first.png";
    const nextSource = "pkg:/images/next.png";
    const render = (source: string, revision: number) => {
      root.render(
        createElement(Image, {
          source,
          style: { width: 300, height: 200 },
          onLoadStart: () => events.push("start " + revision),
          onLoad: () => {
            events.push("load " + revision);
            if (revision === 2) render(nextSource, 3);
          },
          onDisplay: () => events.push("display " + revision),
          onLoadEnd: () => events.push("finish " + revision),
        }),
      );
    };
    try {
      render(firstSource, 1);
      const first = scene.root.children[0].children[0];
      scene.emit(first, "loadStatus", "loading");
      scene.emit(first, "bitmapWidth", 1920);
      render(firstSource, 2);
      expect(scene.root.children[0].children[0]).toBe(first);
      scene.emit(first, "loadStatus", "loading");
      scene.emit(first, "loadStatus", "ready");
      scene.emit(first, "bitmapHeight", 1080);
      expect(events).toEqual(["start 1", "load 2"]);
      const next = scene.root.children[0].children[0];
      expect(next).not.toBe(first);
      scene.emit(next, "bitmapWidth", 640);
      scene.emit(next, "bitmapHeight", 480);
      scene.emit(next, "loadStatus", "ready");
      expect(events).toEqual(["start 1", "load 2", "load 3", "display 3", "finish 3"]);
    } finally {
      root.unmount();
      expect(scene.listenerCount).toBe(0);
    }
  });

  it("finishes the committed Poster load while a replacement render is suspended", async () => {
    const scene = new RecordingSceneGraph();
    const loaded: string[] = [];
    const root = createNativeRoot(scene, {
      viewport: { width: 800, height: 600 },
      text: { prepare() {}, metrics: () => ({ lineHeight: 20, width: () => 10 }) },
    });
    let pending!: () => void;
    const reachedBarrier = new Promise<void>((resolve) => {
      pending = resolve;
    });
    const suspended = new Promise<never>(() => {});
    let replace!: () => void;
    function Barrier({ blocked }: { blocked: boolean }) {
      if (blocked) {
        pending();
        throw suspended;
      }
      return null;
    }
    function Screen() {
      const [next, setNext] = useState(false);
      replace = () => setNext(true);
      return createElement(
        Suspense,
        { fallback: null },
        createElement(Image, {
          source: next ? "pkg:/images/next.png" : "pkg:/images/first.png",
          style: { width: 300, height: 200 },
          onLoad: ({ source }) => loaded.push(source.url),
        }),
        createElement(Barrier, { blocked: next }),
      );
    }
    try {
      root.render(createElement(Screen));
      await root.whenCommitted();
      const first = scene.root.children[0].children[0];
      startTransition(replace);
      await reachedBarrier;
      expect(scene.root.children[0].children[0]).toBe(first);
      scene.emit(first, "bitmapWidth", 640);
      scene.emit(first, "bitmapHeight", 480);
      scene.emit(first, "loadStatus", "ready");
      expect(loaded).toEqual(["pkg:/images/first.png"]);
    } finally {
      root.unmount();
      expect(scene.listenerCount).toBe(0);
    }
  });
});
