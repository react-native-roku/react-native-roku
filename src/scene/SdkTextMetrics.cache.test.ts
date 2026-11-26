import { expect, it, vi } from "vitest";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import type { SdkSceneGraph } from "./SdkSceneGraph";
import type { SceneNodeRef } from "./sceneGraph.types";
import { SdkTextMetrics } from "./SdkTextMetrics";

const api = vi.hoisted(() => ({
  getOneLineHeight: vi.fn(() => 16),
  getOneLineWidth: vi.fn((_node: unknown, text: string) => text.length),
}));
vi.mock("@roku-sdk/runtime/font", () => ({ getFontMeasure: () => api }));

it("scopes bounded width reuse to one prepared native font and drops it on retirement", async () => {
  const scene = Object.assign(new RecordingSceneGraph(), { native: (r: SceneNodeRef) => ({ r }) });
  const fonts = new SdkTextMetrics(scene as unknown as SdkSceneGraph, {
    assets: { Inter: "pkg:/fonts/font.ttf" },
    defaultFamily: "Inter",
  });
  try {
    await fonts.prepare({ fontSize: 12 });
    await fonts.prepare({ fontSize: 14 });
    const metrics = fonts.metrics({ fontSize: 12 });
    expect(metrics.width("")).toBe(0);
    expect(fonts.metrics({ fontSize: 12 }).width("")).toBe(0);
    expect(api.getOneLineWidth).toHaveBeenCalledTimes(1);
    fonts.metrics({ fontSize: 14 }).width("");
    expect(api.getOneLineWidth).toHaveBeenCalledTimes(2);
    for (let index = 0; index < 64; index++) metrics.width(String(index));
    const before = api.getOneLineWidth.mock.calls.length;
    metrics.width("");
    const long = "a".repeat(257);
    metrics.width(long);
    metrics.width(long);
    expect(api.getOneLineWidth).toHaveBeenCalledTimes(before + 3);
    api.getOneLineWidth.mockReturnValueOnce(NaN);
    expect(() => metrics.width("retry")).toThrow();
    expect(metrics.width("retry")).toBe(5);
    fonts.dispose();
    api.getOneLineWidth.mockReturnValueOnce(19);
    expect(metrics.width("")).toBe(19);
  } finally {
    fonts.dispose();
  }
});
