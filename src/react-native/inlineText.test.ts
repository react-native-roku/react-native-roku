import { createElement } from "react";
import { expect, it, vi } from "vitest";
import { Text } from "./primitives";
import { createNativeRoot } from "./createNativeRoot";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import { TextRasterCache } from "../graphics/TextRasterCache";
import { inlineRasterSpecs, overlayRgba } from "../graphics/inlineRaster";
import type { TextRasterSpec } from "../graphics/textRaster.types";
it("keeps nested text styles and markup literals without allocating orphan native labels", async () => {
  const scene = new RecordingSceneGraph(),
    prepared: string[] = [];
  const root = createNativeRoot(scene, {
    viewport: { width: 400, height: 200 },
    text: {
      prepare(style) {
        prepared.push(String(style.fontFamily));
      },
      metrics: () => ({ lineHeight: 20, width: (text) => text.length * 10 }),
      fontAsset: (style) => `fixture:/${style.fontFamily}.ttf`,
    },
  });
  root.render(
    createElement(
      Text,
      {
        numberOfLines: 1,
        style: { fontFamily: "normal", fontSize: 20, color: "white" },
      },
      createElement(Text, { style: { fontFamily: "bold", color: "red" } }, "Director  "),
      "A <B> & C",
    ),
  );
  await root.whenCommitted();
  expect(scene.nodes.size).toBe(2);
  expect(scene.root.children[0].type).toBe("multiStyleLabel");
  expect(scene.root.children[0].fields).toMatchObject({
    text: "<s0>Director  </s0><s1>A &lt;B&gt; &amp; C</s1>",
    drawingStyles: {
      s0: { fontUri: "fixture:/bold.ttf", fontSize: 20, color: "0xFF0000FF" },
      s1: { fontUri: "fixture:/normal.ttf", fontSize: 20, color: "0xFFFFFFFF" },
    },
  });
  expect(prepared).toEqual(["bold", "normal"]);
  root.unmount();
  expect(scene.nodes.size).toBe(1);
});

it("preserves cross-span tracking and ink colors in one leased native bitmap", async () => {
  const scene = new RecordingSceneGraph();
  const mask = vi.fn(async (spec: TextRasterSpec) =>
    new Uint8Array(spec.width * spec.height).fill(255),
  );
  const raster = new TextRasterCache({
    mask,
    write: async (name) => `fixture:/${name}`,
    delete: async () => {},
    dispose() {},
  });
  const root = createNativeRoot(scene, {
    viewport: { width: 400, height: 200 },
    textRaster: raster,
    text: {
      prepare() {},
      metrics: () => ({
        lineHeight: 20,
        width: (value) => Array.from(value).length * 10,
      }),
    },
  });
  try {
    root.render(
      createElement(
        Text,
        {
          numberOfLines: 1,
          style: { fontSize: 20, letterSpacing: -0.8, color: "white" },
        },
        "forest",
        createElement(Text, { style: { color: "red" } }, "."),
      ),
    );
    await root.whenCommitted();
    expect(scene.nodes.size).toBe(2);
    expect(scene.root.children[0].type).toBe("poster");
    expect(scene.root.children[0].fields.uri).toMatch(/^fixture:/);
    expect(mask).toHaveBeenCalledTimes(2);
    const [first, second] = mask.mock.calls.map(([spec]) => spec);
    expect(first.commands.map((command) => command.text).join("")).toBe("forest");
    expect(second.commands.map((command) => command.text).join("")).toBe(".");
    expect(second.commands[0].x).toBeCloseTo((2 + 60 - 6 * 0.8) * 2);
    expect([first.color, second.color]).toEqual(["0xFFFFFFFF", "0xFF0000FF"]);
  } finally {
    root.unmount();
  }
  expect(scene.nodes.size).toBe(1);
  expect(raster.diagnostics().leased).toBe(0);
});

it("composes alpha correctly, keeps individual fonts and refuses unsupported scale/shadow geometry", () => {
  const target = Uint8Array.from([255, 0, 0, 255]);
  overlayRgba(target, Uint8Array.from([0, 0, 255, 128]));
  expect([...target]).toEqual([127, 0, 128, 255]);
  const metrics = {
    lineHeight: 20,
    width: (value: string) => value.length * 10,
  };
  const run = { text: "a", metrics, style: { fontSize: 20, letterSpacing: 1 } };
  const mixed = inlineRasterSpecs({
    runs: [run, { ...run, style: { ...run.style, fontSize: 30 } }],
    width: 100,
    height: 30,
  });
  expect(mixed.map((spec) => spec.fontSize)).toEqual([40, 60]);
  expect(mixed[1].commands[0].x).toBe((2 + 10 + 1) * 2);
  expect(() =>
    inlineRasterSpecs({
      runs: [run, { ...run, style: { ...run.style, fontSize: 20.3 } }],
      width: 100,
      height: 30,
    }),
  ).toThrow(/common bitmap scale/);
  expect(() =>
    inlineRasterSpecs({
      runs: [{ ...run, style: { ...run.style, textShadowColor: "black" } }],
      width: 100,
      height: 30,
    }),
  ).toThrow(/no shadow/);
});
