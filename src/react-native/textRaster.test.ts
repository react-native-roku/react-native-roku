import { createElement } from "react";
import { expect, it, vi } from "vitest";
import { createNativeRoot } from "./createNativeRoot";
import { Text } from "./primitives";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import type { TextRasterLease, TextRasterProvider } from "../graphics/textRaster.types";

it("keeps raster leases through commit, retires superseded preparation, and preserves transform geometry", async () => {
  const pending: Array<(lease: TextRasterLease) => void> = [],
    disposed = vi.fn();
  const raster: TextRasterProvider = {
    acquire: () => new Promise((resolve) => pending.push(resolve)),
    dispose: disposed,
  };
  const scene = new RecordingSceneGraph(),
    root = createNativeRoot(scene, {
      textRaster: raster,
      viewport: { width: 300, height: 200 },
      text: {
        prepare() {},
        metrics: () => ({
          lineHeight: 20,
          width: (value) => value.length * 10,
        }),
      },
    });
  const element = (text: string) =>
    createElement(
      Text,
      {
        style: {
          fontSize: 20,
          width: 100,
          height: 20,
          letterSpacing: 1,
          transform: [{ translateX: 8 }, { scale: 2 }],
        },
      },
      text,
    );
  root.render(element("old"));
  root.render(element("new"));
  const oldRelease = vi.fn(),
    liveRelease = vi.fn();
  pending[0]({
    image: { uri: "fixture:/old.png", width: 106, height: 26, inset: 3 },
    release: oldRelease,
  });
  await Promise.resolve();
  expect(oldRelease).toHaveBeenCalledTimes(1);
  expect(scene.nodes.size).toBe(1);
  pending[1]({
    image: { uri: "fixture:/new.png", width: 106, height: 26, inset: 3 },
    release: liveRelease,
  });
  await root.whenCommitted();
  expect(scene.root.children[0].fields).toMatchObject({
    uri: "fixture:/new.png",
    width: 106,
    height: 26,
    translation: [5, -3],
    scaleRotateCenter: [53, 13],
    scale: [2, 2],
  });
  expect(liveRelease).not.toHaveBeenCalled();
  root.unmount();
  expect(liveRelease).toHaveBeenCalledTimes(1);
  expect(disposed).toHaveBeenCalledTimes(1);
  expect(scene.nodes.size).toBe(1);
});

it("reports missing raster capability through the root error channel", async () => {
  const error = vi.fn(),
    scene = new RecordingSceneGraph(),
    root = createNativeRoot(scene, {
      onError: error,
      viewport: { width: 300, height: 200 },
      text: {
        prepare() {},
        metrics: () => ({ lineHeight: 20, width: () => 10 }),
      },
    });
  root.render(createElement(Text, { style: { fontSize: 20, letterSpacing: 1 } }, "tracked"));
  await expect(root.whenCommitted()).rejects.toThrow("C04_TEXT_RASTER");
  expect(error).toHaveBeenCalledTimes(1);
  expect(() => root.unmount()).toThrow("C04_TEXT_RASTER");
  expect(scene.nodes.size).toBe(1);
});

it("uses the consumer's resolved default font for tracked text", async () => {
  const scene = new RecordingSceneGraph();
  const families: string[] = [];
  const root = createNativeRoot(scene, {
    viewport: { width: 300, height: 200 },
    text: {
      prepare() {},
      fontFamily: (style) => String(style.fontFamily ?? "ConsumerFont"),
      metrics: () => ({ lineHeight: 20, width: (value) => value.length * 10 }),
    },
    textRaster: {
      dispose() {},
      async acquire(request) {
        families.push(String(request.style.fontFamily));
        return {
          image: {
            uri: "fixture:/custom-font",
            width: request.width,
            height: request.height,
            inset: 0,
          },
          release() {},
        };
      },
    },
  });
  root.render(createElement(Text, { style: { fontSize: 20, letterSpacing: 1 } }, "Portable"));
  await root.whenCommitted();
  expect(families).toEqual(["ConsumerFont"]);
  root.unmount();
});
