import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { createNativeRoot } from "../react-native/createNativeRoot";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import { Path, Rect, rectilinearPath, Svg } from "./svg";
import { svgShapeKey } from "./svgKey.mjs";

const text = {
  prepare() {},
  metrics: () => ({ lineHeight: 20, width: () => 10 }),
};
describe("vector adapters", () => {
  it("renders a QR-shaped matrix as exact native rectangles", () => {
    const scene = new RecordingSceneGraph(),
      root = createNativeRoot(scene, {
        text,
        viewport: { width: 800, height: 600 },
      });
    root.render(
      createElement(
        Svg,
        { width: 200, height: 200, viewBox: "0 0 10 10" },
        createElement(Rect, { width: 10, height: 10, fill: "white" }),
        createElement(Path, { d: "M1 2h3v1h-3zM5 5h1v1h-1z", fill: "black" }),
      ),
    );
    const nodes = scene.root.children[0].children;
    expect(nodes).toHaveLength(3);
    expect(nodes[0].fields).toMatchObject({
      width: 200,
      height: 200,
      color: "0xFFFFFFFF",
    });
    expect(nodes[1].fields).toMatchObject({
      translation: [20, 40],
      width: 60,
      height: 20,
      color: "0x000000FF",
    });
    expect(nodes[2].fields).toMatchObject({
      translation: [100, 100],
      width: 20,
      height: 20,
    });
    root.unmount();
    expect(scene.nodes.size).toBe(1);
  });
  it("selects an actual packaged raster by canonical vector geometry, stroke and fill", () => {
    const scene = new RecordingSceneGraph(),
      d = "M1 1L5 5",
      key = svgShapeKey("0 0 24 24", [["path", { d }]]);
    const root = createNativeRoot(scene, {
      text,
      viewport: { width: 800, height: 600 },
      svgAtlas: {
        [key]: { variants: { "1.8:outline": "pkg:/icons/proof.png" } },
      },
    });
    root.render(
      createElement(
        Svg,
        {
          width: 32,
          height: 32,
          viewBox: "0 0 24 24",
          stroke: "#7dd3fc",
          strokeWidth: 1.8,
          fill: "none",
          className: "lucide lucide-proof",
        },
        createElement(Path, { d }),
      ),
    );
    expect(scene.root.children[0].children[0].fields).toMatchObject({
      uri: "pkg:/icons/proof.png",
      width: 32,
      height: 32,
      blendColor: "0x7DD3FCFF",
    });
    root.unmount();
  });
  it("rejects curved and nonrectangular dynamic paths rather than silently omitting geometry", () => {
    expect(() => rectilinearPath("M0 0C1 2 3 4 5 6z")).toThrow(/C09_SVG_PATH/);
    expect(() => rectilinearPath("M0 0h4v2h-2v2h-2z")).toThrow(/rectangular/);
    expect(() => rectilinearPath("M0 0h4v2")).toThrow(/closed/);
  });
  it("routes a numeric curved SVG through the bounded bitmap adapter", async () => {
    const scene = new RecordingSceneGraph(),
      release = vi.fn();
    const acquirePixels = vi.fn(async (request) => {
      expect(request.pixels().some((value: number) => value > 0)).toBe(true);
      return {
        image: {
          uri: "fixture:/curved.png",
          width: request.width,
          height: request.height,
          inset: 0,
        },
        release,
      };
    });
    const root = createNativeRoot(scene, {
      text,
      viewport: { width: 800, height: 600 },
      textRaster: {
        acquire: async () => {
          throw Error("Unexpected text raster");
        },
        acquirePixels,
        dispose() {},
      },
    });
    try {
      root.render(
        createElement(
          Svg,
          { width: 24, height: 24, viewBox: "0 0 24 24", fill: "red" },
          createElement(Path, { d: "M0 0Q24 0 24 24L0 24Z" }),
        ),
      );
      await root.whenCommitted();
      await vi.waitFor(() =>
        expect(
          [...scene.nodes.values()].some((node) => node.fields.uri === "fixture:/curved.png"),
        ).toBe(true),
      );
      expect(acquirePixels).toHaveBeenCalledTimes(1);
    } finally {
      root.unmount();
    }
    expect(release).toHaveBeenCalledTimes(1);
    expect(scene.nodes.size).toBe(1);
  });
});
