import { expect, it, vi } from "vitest";
import { TextRasterCache, type TextRasterTransport } from "./TextRasterCache";
import { textRasterSpec } from "./textRasterGeometry";
import type { TextRasterRequest } from "./textRaster.types";
const request = (color = "white"): TextRasterRequest => ({
  width: 10,
  height: 10,
  style: { fontSize: 10, color },
  layout: { text: "a", lines: ["a"], width: 10, height: 10 },
  metrics: { lineHeight: 10, width: (value) => value.length * 10 },
});

it("shares equivalent rasters, protects live leases, evicts released files, and retires native work", async () => {
  const transport: TextRasterTransport = {
    mask: vi.fn(async (spec) => new Uint8Array(spec.width * spec.height)),
    write: vi.fn(async (name) => `fixture:/${name}`),
    delete: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  const provider = new TextRasterCache(transport, 7000),
    first = await provider.acquire(request()),
    duplicate = await provider.acquire(request()),
    second = await provider.acquire(request("red"));
  expect(duplicate.image).toBe(first.image);
  expect(transport.mask).toHaveBeenCalledTimes(2);
  await expect(provider.acquire(request("blue"))).rejects.toThrow("budget");
  first.release();
  first.release();
  await expect(provider.acquire(request("blue"))).rejects.toThrow("budget");
  duplicate.release();
  const third = await provider.acquire(request("blue"));
  expect(transport.delete).toHaveBeenCalledExactlyOnceWith(first.image.uri);
  second.release();
  third.release();
  provider.dispose();
  provider.dispose();
  expect(transport.dispose).toHaveBeenCalledTimes(1);
  await expect(provider.acquire(request())).rejects.toThrow("retired");
});

it("keeps native font positions and alignment, admits whole non-Latin runs, and rejects unsafe tracked shaping", () => {
  const original = request();
  const tracked = textRasterSpec({
    ...original,
    width: 40,
    style: { fontSize: 10, letterSpacing: 1.25, textAlign: "center" },
    layout: { ...original.layout, text: "ab", lines: ["ab"] },
  });
  expect(tracked.commands.map((command) => command.x)).toEqual([22.75, 45.25]);
  expect(tracked.commands.map((command) => command.text)).toEqual(["a", "b"]);
  const rating = "2026 • Movie • ★ 8.4 ☆";
  const rated = textRasterSpec({
    ...original,
    width: 200,
    style: { fontSize: 10, letterSpacing: 0.25 },
    layout: { ...original.layout, lines: [rating] },
  });
  expect(rated.commands.map((command) => command.text).join("")).toBe(rating);
  expect(
    textRasterSpec({
      ...original,
      layout: { ...original.layout, lines: ["مرحبا"] },
    }).commands[0].text,
  ).toBe("مرحبا");
  expect(() =>
    textRasterSpec({
      ...original,
      style: { fontSize: 10, letterSpacing: 1 },
      layout: { ...original.layout, lines: ["مرحبا"] },
    }),
  ).toThrow("shaping");
});

it("preserves fractional logical font sizes with an integral native bitmap font", () => {
  const original = request();
  const spec = textRasterSpec({
    ...original,
    style: { fontSize: 31.3, letterSpacing: -0.25 },
  });
  expect(Number.isInteger(spec.fontSize)).toBe(true);
  expect(spec.fontSize / spec.scale).toBeCloseTo(31.3);
  expect(Number.isInteger(spec.width) && Number.isInteger(spec.height)).toBe(true);
});

it("shares portable bitmap leases in the bounded native raster owner", async () => {
  const transport: TextRasterTransport = {
    mask: vi.fn(async () => new Uint8Array()),
    write: vi.fn(async (name) => `fixture:/${name}`),
    delete: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  const provider = new TextRasterCache(transport, 400);
  const draw = vi.fn(() => new Uint8Array(400));
  const bitmap = { key: "shape", width: 10, height: 10, pixels: draw };
  const first = await provider.acquirePixels(bitmap),
    same = await provider.acquirePixels(bitmap);
  expect(same.image).toBe(first.image);
  expect(transport.write).toHaveBeenCalledTimes(1);
  expect(draw).toHaveBeenCalledTimes(1);
  await expect(provider.acquirePixels({ ...bitmap, key: "different" })).rejects.toThrow(/budget/);
  first.release();
  same.release();
  await provider.acquirePixels({ ...bitmap, key: "different" });
  expect(transport.delete).toHaveBeenCalledExactlyOnceWith(first.image.uri);
  provider.dispose();
  await expect(provider.acquirePixels(bitmap)).rejects.toThrow(/retired/);
});
