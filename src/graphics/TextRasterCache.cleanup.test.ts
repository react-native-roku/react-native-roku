import { expect, it, vi } from "vitest";
import { TextRasterCache } from "./TextRasterCache";

it("retires admission immediately and retries only a failed transport disposal", async () => {
  const failure = Error("Raster transport disposal failed");
  let failures = 1;
  const dispose = vi.fn(() => {
    if (failures-- > 0) throw failure;
  });
  const cache = new TextRasterCache(
    {
      mask: async () => new Uint8Array(),
      write: async (name) => "fixture:/" + name,
      delete: async () => {},
      dispose,
    },
    400,
  );
  const pixels = { key: "shape", width: 10, height: 10, pixels: new Uint8Array(400) };
  const lease = await cache.acquirePixels(pixels);
  expect(() => cache.dispose()).toThrow(failure);
  expect(cache.diagnostics()).toEqual({ entries: 0, bytes: 0, pending: 0, leased: 0 });
  await expect(cache.acquirePixels(pixels)).rejects.toThrow(/retired/);
  cache.dispose();
  cache.dispose();
  expect(dispose).toHaveBeenCalledTimes(2);
  lease.release();
  lease.release();
});

it("does not replay successful transport cleanup during reentrant disposal", () => {
  const dispose = vi.fn(() => cache.dispose());
  const cache = new TextRasterCache({
    mask: async () => new Uint8Array(),
    write: async (name) => "fixture:/" + name,
    delete: async () => {},
    dispose,
  });
  cache.dispose();
  cache.dispose();
  expect(dispose).toHaveBeenCalledTimes(1);
});
