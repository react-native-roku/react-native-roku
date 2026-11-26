import { expect, it, vi } from "vitest";
import { TextRasterCache, type TextRasterTransport } from "./TextRasterCache";
import type { TextRasterLease } from "./textRaster.types";

function fixture(maximumBytes = 400) {
  let disposed = false;
  const transport: TextRasterTransport = {
    mask: vi.fn(async (spec) => new Uint8Array(spec.width * spec.height)),
    write: vi.fn(async (name) => {
      if (disposed) throw Error("Raster file port already retired");
      return "fixture:/" + name;
    }),
    delete: vi.fn(async () => {}),
    dispose: vi.fn(() => {
      disposed = true;
    }),
  };
  const cache = new TextRasterCache(transport, maximumBytes);
  const pixels = { key: "same", width: 10, height: 10, pixels: () => new Uint8Array(400) };
  return { cache, transport, pixels };
}

it.each([400, 800])(
  "reserves one shared entry before a reentrant same-key draw (budget=%s)",
  async (maximum) => {
    const f = fixture(maximum);
    let nested: Promise<TextRasterLease> | undefined;
    try {
      const outer = f.cache.acquirePixels({
        ...f.pixels,
        pixels: () => {
          nested = f.cache.acquirePixels(f.pixels);
          return new Uint8Array(400);
        },
      });
      // Preserve the existing synchronous invocation contract while registering
      // identity before user code can acquire that identity again.
      expect(nested).toBeDefined();
      const [first, second] = await Promise.all([outer, nested!]);
      expect(first.image).toBe(second.image);
      expect(f.transport.write).toHaveBeenCalledTimes(1);
      expect(f.cache.diagnostics()).toEqual({ entries: 1, bytes: 400, pending: 0, leased: 1 });
      first.release();
      second.release();
      await f.cache.acquirePixels({ ...f.pixels, key: "replacement" });
      expect(f.cache.diagnostics().bytes).toBeLessThanOrEqual(maximum);
    } finally {
      f.cache.dispose();
    }
  },
);

it("does not write or repopulate the cache when a pixel callback disposes its owner", async () => {
  const f = fixture();
  await expect(
    f.cache.acquirePixels({
      ...f.pixels,
      pixels: () => {
        f.cache.dispose();
        return new Uint8Array(400);
      },
    }),
  ).rejects.toThrow("C04_RASTER_DISPOSED");
  expect(f.transport.write).not.toHaveBeenCalled();
  expect(f.cache.diagnostics()).toEqual({ entries: 0, bytes: 0, pending: 0, leased: 0 });
});

it("allows a distinct nested bitmap when both reserved entries fit", async () => {
  const f = fixture(800);
  let nested: Promise<TextRasterLease> | undefined;
  try {
    const outer = f.cache.acquirePixels({
      ...f.pixels,
      pixels: () => {
        nested = f.cache.acquirePixels({ ...f.pixels, key: "different" });
        return new Uint8Array(400);
      },
    });
    const [first, second] = await Promise.all([outer, nested!]);
    expect(first.image).not.toBe(second.image);
    expect(f.transport.write).toHaveBeenCalledTimes(2);
    expect(f.cache.diagnostics()).toEqual({ entries: 2, bytes: 800, pending: 0, leased: 2 });
    first.release();
    second.release();
  } finally {
    f.cache.dispose();
  }
});

it("reserves identity before an eviction callback reacquires the same new key", async () => {
  const f = fixture(),
    old = await f.cache.acquirePixels({ ...f.pixels, key: "old" });
  old.release();
  let nested: Promise<TextRasterLease> | undefined;
  const order: string[] = [];
  vi.mocked(f.transport.delete).mockImplementation(async () => {
    order.push("delete");
    nested = f.cache.acquirePixels(f.pixels);
  });
  vi.mocked(f.transport.write).mockImplementation(async (name) => {
    order.push("write");
    return "fixture:/" + name;
  });
  try {
    const outer = f.cache.acquirePixels(f.pixels);
    expect(nested).toBeDefined();
    const [first, second] = await Promise.all([outer, nested!]);
    expect(first.image).toBe(second.image);
    expect(order).toEqual(["delete", "write"]);
    expect(f.cache.diagnostics()).toEqual({ entries: 1, bytes: 400, pending: 0, leased: 1 });
    first.release();
    second.release();
  } finally {
    f.cache.dispose();
  }
});

it("does not draw after an eviction callback retires the cache", async () => {
  const f = fixture(),
    old = await f.cache.acquirePixels({ ...f.pixels, key: "old" });
  old.release();
  const draw = vi.fn(() => new Uint8Array(400));
  vi.mocked(f.transport.delete).mockImplementation(async () => {
    f.cache.dispose();
  });
  await expect(f.cache.acquirePixels({ ...f.pixels, pixels: draw })).rejects.toThrow(
    "C04_RASTER_DISPOSED",
  );
  expect(draw).not.toHaveBeenCalled();
  expect(f.transport.write).toHaveBeenCalledTimes(1);
  expect(f.cache.diagnostics()).toEqual({ entries: 0, bytes: 0, pending: 0, leased: 0 });
});

it("preserves a throwing retired draw without subtracting an already cleared reservation", async () => {
  const f = fixture(),
    primary = Error("Draw failed after retirement");
  await expect(
    f.cache.acquirePixels({
      ...f.pixels,
      pixels: () => {
        f.cache.dispose();
        throw primary;
      },
    }),
  ).rejects.toBe(primary);
  expect(f.transport.write).not.toHaveBeenCalled();
  expect(f.cache.diagnostics()).toEqual({ entries: 0, bytes: 0, pending: 0, leased: 0 });
});

it("keeps text-mask retirement from restoring an entry or producing a negative byte budget", async () => {
  const f = fixture(10000);
  vi.mocked(f.transport.mask).mockImplementation(async (spec) => {
    f.cache.dispose();
    return new Uint8Array(spec.width * spec.height);
  });
  await expect(
    f.cache.acquire({
      width: 10,
      height: 10,
      style: { fontSize: 10, color: "white" },
      layout: { text: "a", lines: ["a"], width: 10, height: 10 },
      metrics: { lineHeight: 10, width: () => 10 },
    }),
  ).rejects.toThrow("C04_RASTER_DISPOSED");
  expect(f.transport.write).not.toHaveBeenCalled();
  expect(f.cache.diagnostics()).toEqual({ entries: 0, bytes: 0, pending: 0, leased: 0 });
});
