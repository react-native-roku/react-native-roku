import { createElement as h } from "react";
import { expect, it, vi } from "vitest";
import { createNativeRoot } from "./createNativeRoot";
import { Text, View } from "./primitives";
import * as native from "../layout/nativeNodeFields";
import * as affine from "../layout/affine";
import { useNativeHost, type NativeHostContextValue } from "./nativeHostContext";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import { type TextMetricProvider } from "../layout/textLayout";

it("prepares only the changed label and keeps geometry, paint, fonts and text current", async () => {
  const scene = new RecordingSceneGraph();
  let font = scene.create("font"),
    height = 12;
  const text: TextMetricProvider = {
    prepare() {},
    preparedFieldFont: () => font,
    font: () => font,
    metrics: () => ({ lineHeight: height, width: (s) => s.length * 6 }),
  };
  const root = createNativeRoot(scene, { text, viewport: { width: 640, height: 360 } });
  const prepare = vi.spyOn(native, "nativeNodeFields");
  const render = async (title: string, opacity = 1, width = 100, color = "white") => {
    root.render(
      h(
        View,
        { style: { width: 600, height: 300 } },
        h(
          Text,
          { nativeID: "title", style: { width, height: 30, lineHeight: 16, color, opacity } },
          title,
        ),
        ...Array.from({ length: 24 }, (_, i) =>
          h(Text, { key: i, style: { width: 100, height: 20 } }, "Card " + i),
        ),
      ),
    );
    await root.whenCommitted();
  };
  const calls = () => prepare.mock.calls.filter(([node]) => node.type === "label").length;
  const title = () => [...scene.nodes.values()].find((n) => n.fields.id === "title")!.fields;
  try {
    await render("Card 1");
    expect(calls()).toBe(25);
    prepare.mockClear();
    await render("Card 2");
    expect(calls()).toBe(1);
    expect(title().text).toBe("Card 2");
    prepare.mockClear();
    await render("Card 2", 0.6);
    expect(calls()).toBe(1);
    expect(title().opacity).toBe(0.6);
    height = 14;
    prepare.mockClear();
    await render("Card 2", 0.6);
    expect(calls()).toBe(25);
    expect(title().lineSpacing).toBe(2);
    font = scene.create("font");
    await render("Card 2", 0.6);
    expect(title().font).toBe(font);
    await render("a much longer title", 1, 30, "red");
    expect(title().width).toBe(30);
    expect(title().numLines).toBeGreaterThan(1);
    expect(title().color).toBe("0xFF0000FF");
  } finally {
    prepare.mockRestore();
    root.unmount();
  }
});

it("observes nonenumerable and inherited paint values on a stable label", async () => {
  const scene = new RecordingSceneGraph(),
    font = scene.create("font");
  const root = createNativeRoot(scene, {
    viewport: { width: 200, height: 100 },
    text: {
      prepare() {},
      font: () => font,
      preparedFieldFont: () => font,
      metrics: () => ({ lineHeight: 12, width: (s) => s.length * 6 }),
    },
  });
  const render = async (style: Record<string, unknown>) => {
    root.render(h(Text, { nativeID: "label", style }, "Label"));
    await root.whenCommitted();
    return [...scene.nodes.values()].find((n) => n.fields.id === "label")!.fields.color;
  };
  try {
    const style = { width: 100, height: 20 };
    Object.defineProperty(style, "color", { value: "red", writable: true });
    expect(await render(style)).toBe("0xFF0000FF");
    Object.assign(style, { color: "blue" });
    expect(await render(style)).toBe("0x0000FFFF");
    const prototype = { color: "red" };
    const inherited = Object.assign(Object.create(prototype), { width: 100, height: 20 });
    expect(await render(inherited)).toBe("0xFF0000FF");
    prototype.color = "blue";
    expect(await render(inherited)).toBe("0x0000FFFF");
  } finally {
    root.unmount();
  }
});

it("shares plain background geometry across siblings while committing each color and later size", async () => {
  const scene = new RecordingSceneGraph();
  const root = createNativeRoot(scene, {
    viewport: { width: 200, height: 100 },
    text: {
      prepare() {},
      metrics: () => ({ lineHeight: 10, width: (s) => s.length * 6 }),
    },
  });
  const prepare = vi.spyOn(native, "nativeNodeFields");
  const render = async (firstWidth: number, firstColor: string) => {
    root.render(
      h(
        View,
        null,
        h(View, {
          nativeID: "one",
          style: { width: firstWidth, height: 10, backgroundColor: firstColor },
        }),
        h(View, { nativeID: "two", style: { width: 20, height: 10, backgroundColor: "blue" } }),
      ),
    );
    await root.whenCommitted();
  };
  const rectangle = (id: string) =>
    [...scene.nodes.values()].find((n) => n.fields.id === id)!.children[0].fields;
  try {
    await render(20, "red");
    expect(prepare.mock.calls.filter(([n]) => n.type === "rectangle")).toHaveLength(1);
    expect(rectangle("one").color).toBe("0xFF0000FF");
    expect(rectangle("two").color).toBe("0x0000FFFF");
    await render(35, "green");
    expect(rectangle("one")).toMatchObject({ width: 35, height: 10, color: "0x008000FF" });
    expect(rectangle("two")).toMatchObject({ width: 20, height: 10, color: "0x0000FFFF" });
    await render(0, "red");
    expect(rectangle("one").visible).toBe(false);
    expect(rectangle("two").visible).toBe(true);
  } finally {
    prepare.mockRestore();
    root.unmount();
  }
});

it("skips unaffected placement branches while publishing ancestor names and external font changes", async () => {
  const scene = new RecordingSceneGraph(),
    font = scene.create("font");
  let lineHeight = 12;
  const root = createNativeRoot(scene, {
    text: {
      prepare() {},
      font: () => font,
      preparedFieldFont: () => font,
      metrics: () => ({ lineHeight, width: (s) => s.length * 6 }),
    },
    viewport: { width: 400, height: 280 },
  });
  let host!: NativeHostContextValue;
  function Probe() {
    host = useNativeHost();
    return null;
  }
  const unchanged = h(
    View,
    { nativeID: "unchanged", style: { width: 180, height: 60 } },
    h(Text, { nativeID: "fixed", style: { width: 150, height: 30, lineHeight: 20 } }, "Fixed"),
  );
  const render = async (title: string, labelledBy?: string, pointerEvents = "none") => {
    root.render(
      h(
        View,
        {
          nativeID: "ancestor",
          style: { width: 200, height: 130 },
          accessibilityLabelledBy: labelledBy,
          pointerEvents,
        },
        h(Probe),
        h(Text, { nativeID: "changing", style: { width: 150, height: 30 } }, title),
        unchanged,
      ),
    );
    await root.whenCommitted();
  };
  const fixed = () => [...scene.nodes.values()].find((node) => node.fields.id === "fixed")!.fields;
  const bounds = vi.spyOn(affine, "affineBounds");
  try {
    await render("First");
    expect(bounds).toHaveBeenCalledTimes(4);
    bounds.mockClear();
    await render("Second");
    expect(bounds).toHaveBeenCalledTimes(2);
    expect(host.placement("ancestor")?.accessibilityLabel).toBe("Second Fixed");
    expect(fixed().lineSpacing).toBe(8);

    lineHeight = 16;
    bounds.mockClear();
    await render("Third");
    expect(bounds).toHaveBeenCalledTimes(4);
    expect(fixed().lineSpacing).toBe(4);

    bounds.mockClear();
    expect(host.placement("fixed")?.pointerEvents).toBe("none");
    await render("Fourth", undefined, "auto");
    expect(bounds).toHaveBeenCalledTimes(4);
    expect(host.placement("fixed")?.pointerEvents).toBe("auto");

    bounds.mockClear();
    await render("Fifth", "fixed", "auto");
    expect(bounds).toHaveBeenCalledTimes(4);
    expect(host.placement("ancestor")?.accessibilityLabel).toBe("Fixed");
  } finally {
    bounds.mockRestore();
    root.unmount();
  }
});

it("keeps authored tight line boxes while allowing Roku to draw partial lines", async () => {
  const scene = new RecordingSceneGraph();
  const root = createNativeRoot(scene, {
    viewport: { width: 200, height: 120 },
    text: {
      prepare() {},
      metrics: () => ({ lineHeight: 34, width: (text) => text.length * 7 }),
    },
  });
  const label = (id: string) =>
    [...scene.nodes.values()].find((node) => node.fields.id === id)!.fields;
  try {
    root.render(
      h(
        View,
        null,
        h(Text, { nativeID: "tight", style: { width: 150, lineHeight: 29 } }, "Mountain route"),
        h(Text, { nativeID: "default", style: { width: 150 } }, "Mountain route"),
      ),
    );
    await root.whenCommitted();
    expect(label("tight")).toMatchObject({
      height: 29,
      lineSpacing: -5,
      displayPartialLines: true,
      text: "Mountain route",
    });
    expect(label("default")).toMatchObject({ height: 34, lineSpacing: 0 });
    expect(label("default").displayPartialLines).toBeUndefined();
  } finally {
    root.unmount();
  }
});

it("checks a committed layout and its live font once before reusing fixed labels", async () => {
  const scene = new RecordingSceneGraph();
  const font = scene.create("font");
  const prepare = vi.fn();
  let height = 12;
  const readHeight = vi.fn(() => height);
  const text = {
    prepare,
    font: () => font,
    preparedFieldFont: () => font,
    metrics: () => ({ lineHeight: height, width: (value: string) => value.length * 6 }),
    readRetainedFontLineHeight: readHeight,
  };
  const root = createNativeRoot(scene, { text, viewport: { width: 640, height: 360 } });
  const style = { width: 150, height: 40, lineHeight: 20, opacity: 1 };
  const fixed = h(Text, { nativeID: "fixed", style }, "Fixed");
  const read = (id: string) =>
    [...scene.nodes.values()].find((node) => node.fields.id === id)!.fields;
  const render = async (title: string) => {
    root.render(
      h(
        View,
        null,
        h(Text, { nativeID: "title", style: { width: 150, height: 40 } }, title),
        fixed,
      ),
    );
    await root.whenCommitted();
  };
  try {
    await render("One");
    expect(prepare).toHaveBeenCalledTimes(2);
    prepare.mockClear();
    await render("Two");
    expect(readHeight).toHaveBeenCalledExactlyOnceWith(font);
    expect(prepare).not.toHaveBeenCalled();
    expect(read("title").text).toBe("Two");

    style.opacity = 0.5;
    await render("Three");
    expect(read("fixed").opacity).toBe(0.5);
    expect(prepare).not.toHaveBeenCalled();

    height = 16;
    await render("Four");
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(read("fixed").lineSpacing).toBe(4);

    style.width = 120;
    await render("Five");
    expect(read("fixed").width).toBe(120);
  } finally {
    root.unmount();
  }
});
