import type { SceneFields } from "../scene/sceneGraph.types";
import { describe, expect, it } from "vitest";
import { sceneTransform, transformOrigin } from "./transform";
import {
  affineBounds,
  identityAffine,
  multiplyAffine,
  sceneAffine,
  sceneWorld,
  type Affine,
} from "./affine";

const rect = { x: 30, y: 40, width: 100, height: 60 };
describe("ordered native transforms", () => {
  it("keeps a left-anchored timeline progress fill stable while scaling", () => {
    const fields = sceneTransform([{ scaleX: 0.25 }], rect, "left center");
    expect(fields.scaleRotateCenter).toEqual([0, 30]);
    expect(affineBounds(sceneAffine(fields), rect.width, rect.height)).toEqual({
      x: 30,
      y: 40,
      width: 25,
      height: 60,
    });
    expect(transformOrigin(["25%", 12, 0], 200, 100)).toEqual([50, 12]);
    expect(transformOrigin("top right", 200, 100)).toEqual([200, 0]);
    expect(transformOrigin("bottom", 200, 100)).toEqual([100, 100]);
    expect(() => transformOrigin([0, 0, 1], 100, 100)).toThrow("3D");
    expect(() => transformOrigin("left left", 100, 100)).toThrow("coordinate");
  });
  it("preserves the distinction between translation before and after scaling", () => {
    expect(sceneTransform([{ translateX: 10 }, { scale: 2 }], rect).translation).toEqual([40, 40]);
    expect(sceneTransform([{ scale: 2 }, { translateX: 10 }], rect).translation).toEqual([50, 40]);
  });
  it("rotates translations in their actual array order and uses the RN center", () => {
    const fields = sceneTransform([{ rotate: "90deg" }, { translateX: 10 }], rect);
    expect((fields.translation as number[])[0]).toBeCloseTo(30);
    expect((fields.translation as number[])[1]).toBeCloseTo(50);
    expect(fields.rotation).toBeCloseTo(Math.PI / 2);
    expect(fields.scaleRotateCenter).toEqual([50, 30]);
  });
  it("preserves reflection and singular scaling", () => {
    expect(sceneTransform([{ scaleY: -2 }], rect).scale).toEqual([1, -2]);
    expect(sceneTransform([{ scale: 0 }], rect).scale).toEqual([0, 0]);
    expect(sceneTransform([{ scaleX: 0 }], rect).scale).toEqual([0, 1]);
  });
  it("rejects nonrepresentable shear and invalid operations without changing their meaning", () => {
    expect(() => sceneTransform([{ scaleX: 2 }, { rotate: "45deg" }], rect)).toThrow(
      /preserve shear/,
    );
    expect(() => sceneTransform([{ translateX: Infinity }], rect)).toThrow(/finite/);
    expect(() => sceneTransform([{ rotateX: "30deg" }], rect)).toThrow(/supported 2D/);
    expect(() => sceneTransform([{ rotate: "..deg" }], rect)).toThrow(/supported 2D/);
  });
});

it("composes a translated child beneath rotated or scaled ancestors and preserves subpixel bounds", () => {
  const parents: Affine[] = [identityAffine, [0, 1, -1, 0, 30, 50], [-2, 0, 0.5, 2, -3, 4]];
  for (const parent of parents) {
    expect(sceneWorld(parent, {})).toBe(parent);
    const shapes: SceneFields[] = [
      { translation: [4.25, -2.5] },
      { translation: [1, 2], rotation: 0.5, scale: [1.5, 2] },
    ];
    for (const fields of shapes) {
      expect(sceneWorld(parent, fields)).toEqual(multiplyAffine(parent, sceneAffine(fields)));
    }
  }
  const translated = sceneWorld(identityAffine, { translation: [0.1, -2.25] });
  expect(affineBounds(translated, 3.5, 4)).toEqual({ x: 0.1, y: -2.25, width: 3.5, height: 4 });
});
