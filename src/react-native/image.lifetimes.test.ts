import { createElement } from "react";
import { expect, it } from "vitest";
import { createNativeRoot } from "./createNativeRoot";
import { Image, type ImageProps } from "./image";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";

function fixture() {
  const scene = new RecordingSceneGraph(),
    events: unknown[] = [];
  const root = createNativeRoot(scene, {
    strictMode: true,
    viewport: { width: 300, height: 100 },
    text: { prepare() {}, metrics: () => ({ lineHeight: 20, width: () => 8 }) },
  });
  const render = (name: string, props: Partial<ImageProps> = {}) =>
    root.render(
      createElement(Image, {
        source: "https://fixture.invalid/same.png",
        recyclingKey: name,
        style: { width: 80, height: 60 },
        onLoadStart: () => events.push(name + ":start"),
        onLoad: (event) => events.push({ name, source: event.source }),
        onDisplay: () => events.push(name + ":display"),
        onLoadEnd: () => events.push(name + ":end"),
        onError: () => events.push(name + ":error"),
        ...props,
      }),
    );
  const poster = () => [...scene.nodes.values()].find((node) => node.type === "poster")!;
  const ready = (node: ReturnType<typeof poster>, width = 100, height = 50) => {
    scene.emit(node, "loadStatus", "loading");
    scene.emit(node, "bitmapWidth", width);
    scene.emit(node, "bitmapHeight", height);
    scene.emit(node, "loadStatus", "ready");
  };
  const dispose = () => {
    root.unmount();
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
  };
  return { scene, root, events, render, poster, ready, dispose };
}

it("resets a completed same-URI load when its recycling key changes", () => {
  const f = fixture();
  try {
    f.render("a");
    const first = f.poster();
    f.ready(first);
    f.render("b");
    const second = f.poster();
    expect(second.id).not.toBe(first.id);
    f.ready(second, 200, 80);
    expect(f.events).toEqual([
      "a:start",
      { name: "a", source: { url: "https://fixture.invalid/same.png", width: 100, height: 50 } },
      "a:display",
      "a:end",
      "b:start",
      { name: "b", source: { url: "https://fixture.invalid/same.png", width: 200, height: 80 } },
      "b:display",
      "b:end",
    ]);
    f.scene.emit(first, "loadStatus", "failed");
    expect(f.events).toHaveLength(8);
  } finally {
    f.dispose();
  }
});

it("does not combine old readiness or dimensions with a partially prepared successor", () => {
  const f = fixture();
  try {
    f.render("a");
    const first = f.poster();
    f.scene.emit(first, "loadStatus", "ready");
    f.scene.emit(first, "bitmapWidth", 100);
    f.render("b");
    const second = f.poster();
    f.scene.emit(second, "bitmapHeight", 80);
    expect(f.events).toEqual([]);
    f.scene.emit(second, "loadStatus", "ready");
    expect(f.events).toEqual([]);
    f.scene.emit(second, "bitmapWidth", 200);
    expect(f.events).toEqual([
      { name: "b", source: { url: "https://fixture.invalid/same.png", width: 200, height: 80 } },
      "b:display",
      "b:end",
    ]);
  } finally {
    f.dispose();
  }
});

it("uses an unambiguous source/recycling tuple for native Poster identity", () => {
  const f = fixture();
  try {
    f.render("row", { source: "https://first.invalid/a:https://second.invalid/b" });
    const first = f.poster();
    f.render("row:https://first.invalid/a", { source: "https://second.invalid/b" });
    expect(f.poster().id).not.toBe(first.id);
  } finally {
    f.dispose();
  }
});

it("keeps a failed generation terminal and lets a recycled successor load", () => {
  const f = fixture();
  try {
    f.render("a");
    const failed = f.poster();
    f.scene.emit(failed, "loadStatus", "failed");
    f.scene.emit(failed, "loadStatus", "loading");
    f.ready(failed);
    expect(f.events).toEqual(["a:error", "a:end"]);
    f.render("b");
    f.ready(f.poster());
    expect(f.events.slice(2)).toEqual([
      "b:start",
      { name: "b", source: { url: "https://fixture.invalid/same.png", width: 100, height: 50 } },
      "b:display",
      "b:end",
    ]);
  } finally {
    f.dispose();
  }
});

it("does not continue old public callbacks after onLoad retires the image owner", () => {
  const f = fixture();
  try {
    f.render("a", {
      onLoad: () => {
        f.events.push("retire");
        f.root.render(null);
      },
    });
    f.ready(f.poster());
    expect(f.events).toEqual(["a:start", "retire"]);
  } finally {
    f.dispose();
  }
});

it("preserves a successor admitted from an old failure callback", () => {
  const f = fixture();
  try {
    f.render("a", {
      onError: () => {
        f.events.push("replace");
        f.render("b");
      },
    });
    f.scene.emit(f.poster(), "loadStatus", "failed");
    expect(f.events).toEqual(["replace"]);
    f.ready(f.poster());
    expect(f.events.slice(1)).toEqual([
      "b:start",
      { name: "b", source: { url: "https://fixture.invalid/same.png", width: 100, height: 50 } },
      "b:display",
      "b:end",
    ]);
  } finally {
    f.dispose();
  }
});
