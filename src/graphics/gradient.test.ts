import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { createNativeRoot } from "../react-native/createNativeRoot";
import { LinearGradient } from "../react-native/linearGradient";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import { gradientFields } from "./gradient";

describe("authored gradient geometry", () => {
  it("preserves partial horizontal spans, reverse direction, and rectangular diagonals", () => {
    expect(
      gradientFields(
        {
          start: { x: 0.25, y: 0.5 },
          end: { x: 0.75, y: 0.5 },
          locations: [0, 0.5, 1],
        },
        200,
        100,
      ),
    ).toEqual({ gradientAngle: 90, gradientStops: [0.25, 0.5, 0.75] });
    expect(
      gradientFields(
        { start: { x: 1, y: 0.5 }, end: { x: 0, y: 0.5 }, locations: [0, 1] },
        200,
        100,
      ),
    ).toEqual({
      gradientAngle: 270,
      gradientStops: [0, 1],
    });
    const diagonal = gradientFields(
      { start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, locations: [0, 1] },
      200,
      100,
    );
    expect(diagonal.gradientAngle).toBeCloseTo(116.565051);
    expect(diagonal.gradientStops).toEqual([0, 1]);
  });
  it("uses a transparent native base and a downwards default fade over artwork", () => {
    const scene = new RecordingSceneGraph();
    const root = createNativeRoot(scene, {
      text: { prepare() {}, metrics: () => ({ lineHeight: 20, width: () => 10 }) },
      viewport: { width: 480, height: 270 },
      graphics: { effects: true },
    });
    try {
      root.render(
        createElement(LinearGradient, {
          colors: ["rgba(9,9,11,0)", "rgba(9,9,11,0.05)", "#09090b"],
          locations: [0, 0.86, 1],
          style: { width: 480, height: 270 },
        }),
      );
      const rectangle = scene.root.children[0].children[0];
      const effect = rectangle.children[0];
      expect(rectangle.fields).toMatchObject({ color: "0x00000000", effect });
      expect(effect.fields).toMatchObject({
        gradientAngle: 180,
        gradientColors: ["0x09090B00", "0x09090B0D", "0x09090BFF"],
        gradientStops: [0, 0.86, 1],
      });
    } finally {
      root.unmount();
    }
  });
  it("rejects invalid stops and zero vectors, including before an element is visible", () => {
    expect(() =>
      gradientFields(
        { start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, locations: [0.7, 0.4] },
        200,
        100,
      ),
    ).toThrow("ordered");
    expect(() =>
      gradientFields({ start: { x: 0, y: 0 }, end: { x: 0, y: 0 }, locations: [0, 1] }, 200, 100),
    ).toThrow("distinct");
    expect(() =>
      gradientFields({ start: { x: -1, y: 0 }, end: { x: 0, y: 1 }, locations: [0, 1] }, 0, 0),
    ).toThrow("[0,1]");
  });
});
