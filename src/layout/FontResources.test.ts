import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import {
  FontResources,
  type FontCancellation,
  type FontEngine,
  type FontResourcesOptions,
} from "./FontResources";

const options = {
  assets: { Inter: "pkg:/fonts/Inter.ttf" },
  defaultFamily: "Inter",
};
const metrics = { lineHeight: 20, width: (text: string) => text.length * 8 };
afterEach(() => vi.useRealTimers());

describe("font resource ownership", () => {
  it("keeps prepared and newly sized fonts on the captured physical asset map", async () => {
    const scene = new RecordingSceneGraph(),
      assets = { Inter: "pkg:/original.ttf" };
    const fonts = new FontResources(
      scene,
      { ready: async () => {}, metrics: () => metrics },
      { assets, defaultFamily: "Inter" },
    );
    try {
      await fonts.prepare({ fontSize: 20 });
      const first = fonts.font({ fontSize: 20 });
      assets.Inter = "pkg:/replacement.ttf";
      expect(fonts.fontAsset({ fontSize: 20 })).toBe("pkg:/original.ttf");
      await fonts.prepare({ fontSize: 22 });
      expect(scene.nodes.get(first.id)?.fields.uri).toBe("pkg:/original.ttf");
      expect(scene.nodes.get(fonts.font({ fontSize: 22 }).id)?.fields.uri).toBe(
        "pkg:/original.ttf",
      );
    } finally {
      fonts.dispose();
    }
    expect(scene.nodes.size).toBe(1);
  });

  it("keeps an in-flight font's declared asset identical to the URI submitted before readiness", async () => {
    const scene = new RecordingSceneGraph(),
      assets: Record<string, string> = { Inter: "pkg:/original.ttf" };
    let finish!: () => void;
    const fonts = new FontResources(
      scene,
      {
        ready: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
        metrics: () => metrics,
      },
      { assets, defaultFamily: "Inter" },
    );
    try {
      const preparation = fonts.prepare({ fontSize: 20 });
      await Promise.resolve();
      delete assets.Inter;
      finish();
      await preparation;
      expect(fonts.fontAsset({ fontSize: 20 })).toBe("pkg:/original.ttf");
      expect(scene.nodes.get(fonts.font({ fontSize: 20 }).id)?.fields.uri).toBe(
        "pkg:/original.ttf",
      );
    } finally {
      fonts.dispose();
    }
    expect(scene.nodes.size).toBe(1);
  });
  it("selects real configured weight/style faces before applying a numeric variant", async () => {
    const scene = new RecordingSceneGraph();
    const fonts = new FontResources(
      scene,
      { ready: async () => undefined, metrics: () => metrics },
      {
        defaultFamily: "Body",
        assets: {
          Regular: "pkg:/regular.ttf",
          Medium: "pkg:/medium.ttf",
          Bold: "pkg:/bold.ttf",
          BoldItalic: "pkg:/bold-italic.ttf",
          "BoldItalic::tabular-nums": "pkg:/bold-italic-tabular.ttf",
        },
        families: {
          Body: {
            normal: { 400: "Regular", 500: "Medium", 700: "Bold" },
            italic: { 700: "BoldItalic" },
          },
        },
      },
    );
    try {
      await fonts.prepare({});
      await fonts.prepare({ fontWeight: 500 });
      await fonts.prepare({ fontWeight: "bold" });
      const italic = { fontWeight: "700", fontStyle: "italic", fontVariant: ["tabular-nums"] };
      await fonts.prepare(italic);
      expect(fonts.fontAsset({})).toBe("pkg:/regular.ttf");
      expect(fonts.fontAsset({ fontWeight: "500" })).toBe("pkg:/medium.ttf");
      expect(fonts.fontAsset({ fontWeight: 700 })).toBe("pkg:/bold.ttf");
      expect(fonts.fontAsset(italic)).toBe("pkg:/bold-italic-tabular.ttf");
      expect(fonts.font({ fontFamily: fonts.fontFamily(italic) })).toBe(fonts.font(italic));
      expect(fonts.font({ fontWeight: "normal" })).toBe(fonts.font({}));
      expect(fonts.font({ fontFamily: "Bold", fontWeight: 700 })).toBe(
        fonts.font({ fontWeight: "bold" }),
      );
      expect(fonts.font({ fontFamily: "Bold", fontWeight: 400 })).toBe(
        fonts.font({ fontWeight: 700 }),
      );
      expect(fonts.fontAsset({ fontFamily: "Bold", fontWeight: 400, fontStyle: "italic" })).toBe(
        "pkg:/bold-italic.ttf",
      );
      expect(
        fonts.fontAsset({ fontFamily: "BoldItalic", fontWeight: 400, fontStyle: "italic" }),
      ).toBe("pkg:/bold-italic.ttf");
      await fonts.prepare({ fontFamily: "Bold", fontWeight: 400, fontStyle: "italic" });
      expect(fonts.font({ fontFamily: "Bold", fontWeight: 400, fontStyle: "italic" })).toBe(
        fonts.font({ fontWeight: 700, fontStyle: "italic" }),
      );
    } finally {
      fonts.dispose();
    }
    expect(scene.nodes.size).toBe(1);
  });

  it("rejects unavailable faces and invalid group configuration before native allocation", () => {
    const scene = new RecordingSceneGraph(),
      engine = { ready: async () => undefined, metrics: () => metrics };
    for (const families of [
      { Body: { normal: { 400: "Missing" } } },
      { Body: { normal: { 450: "Inter" } } },
      { Body: { normal: { 400: "Inter" }, oblique: { 700: "Inter" } } },
      { Inter: { normal: { 400: "Inter" } } },
    ])
      expect(
        () =>
          new FontResources(scene, engine, {
            ...options,
            families: families as unknown as FontResourcesOptions["families"],
          }),
      ).toThrow(/C04_FONT_FACE_CONFIG/);
    const families = { Body: { normal: { 400: "Inter" } } };
    const fonts = new FontResources(scene, engine, { ...options, defaultFamily: "Body", families });
    try {
      expect(() => fonts.prepare({ fontWeight: 700 })).toThrow(/C04_FONT_FACE/);
      expect(() => fonts.prepare({ fontStyle: "italic" })).toThrow(/C04_FONT_FACE/);
      expect(() => fonts.prepare({ fontWeight: "bolder" })).toThrow(/C04_FONT_WEIGHT/);
      expect(() => fonts.prepare({ fontStyle: "oblique" })).toThrow(/C04_FONT_STYLE/);
      expect(scene.nodes.size).toBe(1);
    } finally {
      fonts.dispose();
    }
  });

  it("refuses conflicting italic mappings for a physical alias before allocation", () => {
    const scene = new RecordingSceneGraph();
    const fonts = new FontResources(
      scene,
      { ready: async () => undefined, metrics: () => metrics },
      {
        defaultFamily: "Body",
        assets: { Regular: "regular.ttf", Italic: "italic.ttf", OtherItalic: "other-italic.ttf" },
        families: {
          Body: { normal: { 400: "Regular" }, italic: { 400: "Italic" } },
          Other: { normal: { 400: "Regular" }, italic: { 400: "OtherItalic" } },
        },
      },
    );
    try {
      expect(() => fonts.prepare({ fontFamily: "Regular", fontStyle: "italic" })).toThrow(
        /ambiguous italic/,
      );
      expect(scene.nodes.size).toBe(1);
    } finally {
      fonts.dispose();
    }
  });

  it("snapshots face declarations and refuses synthetic weight for an unconfigured physical family", async () => {
    const scene = new RecordingSceneGraph(),
      families = { Body: { normal: { 400: "Inter", 700: "Bold" } } };
    const fonts = new FontResources(
      scene,
      { ready: async () => undefined, metrics: () => metrics },
      {
        ...options,
        defaultFamily: "Body",
        assets: { ...options.assets, Bold: "pkg:/bold.ttf" },
        families,
      },
    );
    try {
      families.Body.normal[700] = "Inter";
      await fonts.prepare({ fontWeight: 700 });
      expect(fonts.fontAsset({ fontWeight: 700 })).toBe("pkg:/bold.ttf");
      expect(() => fonts.prepare({ fontFamily: "Inter", fontWeight: 700 })).toThrow(
        /C04_FONT_FACE/,
      );
    } finally {
      fonts.dispose();
    }
    expect(scene.nodes.size).toBe(1);
  });
  it("selects the same explicit tabular face for metrics, native labels and raster identity", async () => {
    const scene = new RecordingSceneGraph();
    const fonts = new FontResources(
      scene,
      {
        ready: async () => undefined,
        metrics: () => metrics,
      },
      {
        ...options,
        assets: { ...options.assets, "Inter::tabular-nums": "pkg:/fonts/Inter-tabular.ttf" },
      },
    );
    const style = { fontSize: 24, fontVariant: ["tabular-nums"] };
    try {
      await fonts.prepare({ fontSize: 24 });
      await fonts.prepare(style);
      expect(fonts.font(style)).not.toBe(fonts.font({ fontSize: 24 }));
      expect(fonts.fontAsset(style)).toBe("pkg:/fonts/Inter-tabular.ttf");
      expect(fonts.fontFamily(style)).toBe("Inter::tabular-nums");
      // Rasterization carries the resolved family key after metrics preparation.
      expect(fonts.font({ fontFamily: fonts.fontFamily(style), fontSize: 24 })).toBe(
        fonts.font(style),
      );
      expect(
        fonts.prepare({ ...style, fontVariant: ["tabular-nums", "tabular-nums"] }),
      ).toBeUndefined();
    } finally {
      fonts.dispose();
    }
    expect(scene.nodes.size).toBe(1);
  });

  it("refuses unconfigured or unsupported font variants before allocating a native font", () => {
    const scene = new RecordingSceneGraph();
    const fonts = new FontResources(
      scene,
      { ready: async () => undefined, metrics: () => metrics },
      options,
    );
    try {
      expect(() => fonts.prepare({ fontVariant: ["tabular-nums"] })).toThrow(
        /C04_FONT_VARIANT_ASSET/,
      );
      expect(() => fonts.prepare({ fontVariant: ["small-caps"] })).toThrow(/C04_FONT_VARIANT/);
      expect(() => fonts.prepare({ fontVariant: "tabular-nums" })).toThrow(/C04_FONT_VARIANT/);
      expect(scene.nodes.size).toBe(1);
    } finally {
      fonts.dispose();
    }
  });
  it("deduplicates readiness, shares the measured font, and releases resources once", async () => {
    const scene = new RecordingSceneGraph();
    let ready!: () => void;
    const engine: FontEngine = {
      ready: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            ready = resolve;
          }),
      ),
      metrics: () => metrics,
    };
    const fonts = new FontResources(scene, engine, options);
    const first = fonts.prepare({ fontSize: 20 });
    expect(fonts.prepare({ fontSize: 20 })).toBe(first);
    expect(() => fonts.metrics({ fontSize: 20 })).toThrow(/before readiness/);
    await Promise.resolve();
    ready();
    await first;
    expect(engine.ready).toHaveBeenCalledTimes(1);
    expect(fonts.prepare({ fontSize: 20 })).toBeUndefined();
    expect(fonts.metrics({ fontSize: 20 }).lineHeight).toBe(20);
    expect(fonts.font({ fontSize: 20 }).type).toBe("font");
    fonts.dispose();
    fonts.dispose();
    expect(scene.nodes.size).toBe(1);
    expect(() => fonts.prepare({})).toThrow(/disposed/);
  });

  it("ends a stalled readiness wait at its deadline and cancels the host poll", async () => {
    vi.useFakeTimers();
    const scene = new RecordingSceneGraph();
    let observed!: FontCancellation;
    const fonts = new FontResources(
      scene,
      {
        ready: (_ref, signal) => {
          observed = signal;
          return new Promise(() => undefined);
        },
        metrics: () => metrics,
      },
      { ...options, timeoutMs: 100 },
    );
    const preparation = fonts.prepare({});
    const assertion = expect(preparation).rejects.toThrow(/did not become measurable/);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(observed.aborted).toBe(true);
    expect(scene.nodes.size).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    fonts.dispose();
  });

  it("cancels outstanding preparation during unmount without a late native allocation", async () => {
    const scene = new RecordingSceneGraph();
    let finish!: () => void;
    const fonts = new FontResources(
      scene,
      {
        ready: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
        metrics: () => metrics,
      },
      options,
    );
    const preparation = fonts.prepare({});
    await Promise.resolve();
    fonts.dispose();
    await expect(preparation).rejects.toThrow(/disposed/);
    finish();
    await Promise.resolve();
    expect(scene.nodes.size).toBe(1);
  });

  it("rejects missing assets, invalid metrics and resource-budget growth", async () => {
    const scene = new RecordingSceneGraph();
    const fonts = new FontResources(
      scene,
      {
        ready: async () => undefined,
        metrics: () => ({ ...metrics, lineHeight: 0 }),
      },
      { ...options, maximumFonts: 1 },
    );
    expect(() => fonts.prepare({ fontFamily: "Missing" })).toThrow(/No packaged font/);
    await expect(fonts.prepare({ fontSize: 15 })).rejects.toThrow(/invalid metrics/);
    expect(scene.nodes.size).toBe(1);
    expect(() => fonts.prepare({ fontSize: 16 })).toThrow(/budget/);
    fonts.dispose();
  });
});
