import { createElement } from "react";
import { expect, it } from "vitest";
import { Text, View } from "./primitives";
import { createNativeRoot } from "./createNativeRoot";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";

const text = {
  prepare() {},
  metrics: (style: Record<string, unknown>) => ({
    lineHeight: style.fontFamily === "bold" ? 24 : 20,
    width: (value: string) => Array.from(value).length * (style.fontFamily === "bold" ? 12 : 10),
  }),
  fontAsset: (style: Record<string, unknown>) => `fixture:/${String(style.fontFamily)}.ttf`,
};

it("wraps across style boundaries with exact fonts, colors and authored line heights", async () => {
  const scene = new RecordingSceneGraph();
  const root = createNativeRoot(scene, { viewport: { width: 300, height: 300 }, text });
  const paragraph = (width: number) =>
    createElement(
      Text,
      {
        nativeID: "paragraph",
        style: { width, fontFamily: "normal", fontSize: 20, lineHeight: 20, color: "white" },
      },
      "aa",
      createElement(
        Text,
        {
          style: { fontFamily: "bold", fontSize: 24, lineHeight: 30, color: "red" },
        },
        "bb",
      ),
      " cc",
    );
  try {
    root.render(paragraph(50));
    await root.whenCommitted();
    const group = scene.root.children[0];
    expect(group.type).toBe("group");
    expect(group.children).toHaveLength(2);
    const [first, second] = group.children;
    expect(first.type).toBe("multiStyleLabel");
    expect(first.fields).toMatchObject({ translation: [0, 0], width: 50, height: 30, wrap: false });
    expect(first.fields.text).toBe("<s0>aa</s0><s1>bb</s1>");
    expect(first.fields.drawingStyles).toMatchObject({
      s0: { fontUri: "fixture:/normal.ttf", fontSize: 20, color: "0xFFFFFFFF" },
      s1: { fontUri: "fixture:/bold.ttf", fontSize: 24, color: "0xFF0000FF" },
    });
    expect(second.fields).toMatchObject({ translation: [0, 30], text: "<s0>cc</s0>", height: 20 });
    root.render(paragraph(150));
    await root.whenCommitted();
    expect(scene.root.children[0]).toBe(group);
    expect(group.children).toHaveLength(1);
    expect(group.children[0]).toBe(first);
    expect(scene.nodes.has(second.id)).toBe(false);
    expect(String(first.fields.text).replace(/<[^>]*>/g, "")).toBe("aabb cc");
    for (let index = 0; index < 20; index++) {
      root.render(paragraph(index % 2 ? 150 : 50));
      await root.whenCommitted();
      expect(scene.nodes.size).toBe(index % 2 ? 3 : 4);
    }
  } finally {
    root.unmount();
  }
  expect(scene.nodes.size).toBe(1);
  expect(scene.listenerCount).toBe(0);
});

it("retains styled ellipsis, explicit blank lines and cleans derived lines with an ancestor", async () => {
  const scene = new RecordingSceneGraph();
  const root = createNativeRoot(scene, { viewport: { width: 300, height: 300 }, text });
  try {
    root.render(
      createElement(
        View,
        null,
        createElement(
          Text,
          {
            numberOfLines: 2,
            style: { width: 25, fontFamily: "normal", fontSize: 20 },
          },
          "aa ",
          createElement(Text, { style: { color: "red" } }, "bb"),
          " cc dd",
        ),
      ),
    );
    await root.whenCommitted();
    const lines = scene.root.children[0].children[0].children;
    expect(lines.map((line) => String(line.fields.text).replace(/<[^>]*>/g, ""))).toEqual([
      "aa",
      "b…",
    ]);
    expect(lines[1].fields.drawingStyles).toMatchObject({ s1: { color: "0xFF0000FF" } });
    root.render(
      createElement(
        Text,
        { style: { width: 100, fontFamily: "normal", fontSize: 20 } },
        "A\n\n",
        createElement(Text, { style: { color: "red" } }, "<B> & C"),
      ),
    );
    await root.whenCommitted();
    const current = scene.root.children[0].children;
    expect(current).toHaveLength(3);
    expect(current[0].fields.text).toBe("<s0>A</s0>");
    expect(current[1].fields.text).toBe("");
    expect(current[2].fields.text).toBe("<s1>&lt;B&gt; &amp; C</s1>");
    expect(scene.nodes.size).toBe(5);
    root.render(null);
    await root.whenCommitted();
    expect(scene.nodes.size).toBe(1);
    root.render(createElement(Text, null, createElement(Text, null)));
    await root.whenCommitted();
    expect(scene.root.children[0].children).toHaveLength(0);
  } finally {
    root.unmount();
  }
});
