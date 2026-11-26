import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import { createNativeRoot } from "../react-native/createNativeRoot";
import { View } from "../react-native/primitives";
import { hasRoundedCorners, roundedMask, surfaceRadii } from "./surfaces";

const text = {
  prepare() {},
  metrics: () => ({ lineHeight: 20, width: () => 10 }),
};
describe("rounded native surfaces and clipping", () => {
  it("normalizes overlapping corners and rejects invalid radii", () => {
    expect(surfaceRadii({ borderRadius: 999 }, 100, 60)).toEqual([30, 30, 30, 30]);
    expect(surfaceRadii({ borderTopLeftRadius: 80, borderTopRightRadius: 40 }, 60, 200)).toEqual([
      40, 20, 0, 0,
    ]);
    expect(() => hasRoundedCorners({ borderRadius: -1 })).toThrow(/finite nonnegative/);
  });

  it("composes radii in the same alpha bitmap and preserves the interior and square corners", () => {
    const style = { borderRadius: 18, borderBottomLeftRadius: 0 };
    const mask = roundedMask(style, 64, 40);
    const rgba = mask.pixels();
    const alpha = (x: number, y: number) => rgba[(y * mask.width + x) * 4 + 3];
    expect([alpha(1, 1), alpha(62, 1), alpha(62, 38), alpha(1, 38)]).toEqual([0, 0, 0, 255]);
    expect([alpha(31, 0), alpha(0, 19), alpha(31, 19), alpha(31, 39)]).toEqual([
      255, 255, 255, 255,
    ]);
    expect(roundedMask(style, 64, 40).key).toBe(mask.key);
    expect(roundedMask(style, 65, 40).key).not.toBe(mask.key);
  });

  it("keeps the composed mask and child mounted on a radius update and retires their leases", async () => {
    const scene = new RecordingSceneGraph();
    const release = vi.fn();
    const acquirePixels = vi.fn(async (mask: ReturnType<typeof roundedMask>) => ({
      image: { uri: "fixture:/" + mask.key, width: mask.width, height: mask.height, inset: 0 },
      release,
    }));
    const root = createNativeRoot(scene, {
      text,
      viewport: { width: 800, height: 600 },
      graphics: { effects: true, composedMasks: true },
      textRaster: { acquire: vi.fn(), acquirePixels, dispose() {} },
    });
    const render = (radius: number) =>
      root.render(
        createElement(
          View,
          { style: { width: 64, height: 40, borderRadius: radius, overflow: "hidden" } },
          createElement(View, { nativeID: "clipped", style: { width: 64, height: 40 } }),
        ),
      );
    try {
      render(18);
      await root.whenCommitted();
      const masks = [...scene.nodes.values()].filter((node) => node.type === "maskGroup");
      expect(masks).toHaveLength(1);
      const mask = masks[0],
        gate = mask.children[0],
        child = gate.children[0];
      const previousURI = mask.fields.maskUri;
      expect(mask.fields.maskSize).toEqual([64, 40]);
      expect(gate.fields.visible).toBe(false);
      root.runSync(() => scene.emit(mask, "maskBitmapWidth", 64));
      await root.whenCommitted();
      expect(gate.fields.visible).toBe(false);
      root.runSync(() => scene.emit(mask, "maskBitmapHeight", 40));
      await root.whenCommitted();
      expect(gate.fields.visible).toBe(true);
      render(10);
      await root.whenCommitted();
      expect(scene.nodes.get(mask.id)).toBe(mask);
      expect(scene.nodes.get(child.id)).toBe(child);
      expect(mask.fields.maskUri).not.toBe(previousURI);
      expect(release).toHaveBeenCalledTimes(acquirePixels.mock.calls.length - 1);
    } finally {
      root.unmount();
    }
    expect(release).toHaveBeenCalledTimes(acquirePixels.mock.calls.length);
    expect(scene.nodes.size).toBe(1);
    expect(scene.listenerCount).toBe(0);
  });
  it("references a live Effect and paints an inside border without changing Yoga geometry", () => {
    const scene = new RecordingSceneGraph(),
      root = createNativeRoot(scene, {
        text,
        viewport: { width: 800, height: 600 },
        graphics: { effects: true },
      });
    root.render(
      createElement(
        View,
        {
          style: {
            width: 200,
            height: 100,
            borderRadius: 20,
            borderWidth: 2,
            borderColor: "red",
            backgroundColor: "blue",
            padding: 10,
          },
        },
        createElement(View, { style: { width: 30, height: 20 } }),
      ),
    );
    const surface = scene.root.children[0].children[0],
      effect = surface.children[0];
    expect(surface.fields).toMatchObject({
      width: 196,
      height: 96,
      translation: [2, 2],
      effect,
    });
    expect(effect.fields).toMatchObject({
      borderRadius: [18, 18, 18, 18],
      borderWidth: 2,
      borderColor: "0xFF0000FF",
    });
    expect(effect.fields.visible).toBeUndefined();
    expect(effect.fields.translation).toBeUndefined();
    expect(scene.root.children[0].children[1].fields.translation).toEqual([12, 12]);
    root.unmount();
    expect(scene.nodes.size).toBe(1);
  });
  it("gates rounded child clipping on four actual mask observations and preserves child identity", () => {
    const scene = new RecordingSceneGraph(),
      root = createNativeRoot(scene, {
        text,
        viewport: { width: 800, height: 600 },
        graphics: {
          effects: true,
          cornerMasks: [
            "pkg:/corner-0.png",
            "pkg:/corner-1.png",
            "pkg:/corner-2.png",
            "pkg:/corner-3.png",
          ],
        },
      });
    const render = (radius: number) =>
      root.render(
        createElement(
          View,
          {
            style: {
              width: 200,
              height: 100,
              borderRadius: radius,
              overflow: "hidden",
              padding: 10,
            },
          },
          createElement(View, {
            nativeID: "child",
            style: { width: 30, height: 20 },
          }),
        ),
      );
    render(20);
    const masks = [...scene.nodes.values()].filter((node) => node.type === "maskGroup"),
      child = [...scene.nodes.values()].find((node) => node.fields.id === "child")!;
    expect(masks).toHaveLength(4);
    expect(masks.every((node) => node.fields.visible === true)).toBe(true);
    const gate = masks[3].children[0];
    expect(gate.fields.visible).toBe(false);
    expect(masks[1].fields.maskOffset).toEqual([180, 0]);
    expect(masks[1].fields.maskSize).toEqual([(257 * 20) / 256, (257 * 20) / 256]);
    expect(child.fields.translation).toEqual([10, 10]);
    root.runSync(() => {
      masks.forEach((node) => {
        scene.emit(node, "maskBitmapWidth", 257);
        scene.emit(node, "maskBitmapHeight", 257);
      });
    });
    expect(gate.fields.visible).toBe(true);
    render(12);
    expect(scene.nodes.get(child.id)).toBe(child);
    expect(masks[1].fields.maskOffset).toEqual([188, 0]);
    root.unmount();
    expect(scene.listenerCount).toBe(0);
    expect(scene.nodes.size).toBe(1);
  });
});
