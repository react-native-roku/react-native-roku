import { TextRasterCache } from "react-native-roku/text-raster-cache";
import type { TextRasterLease } from "react-native-roku/text-raster";

/** Installed public cache with reentrant draw/file ports; no native pixels claimed. */
export async function qualifyRasterReservations() {
  const demand = (condition: unknown, message: string) => {
    if (!condition) throw Error("Packed raster reservation: " + message);
  };
  const results = [];
  for (const kind of [
    "draw",
    "eviction",
    "distinct",
    "retirement",
    "throwing-retirement",
  ] as const) {
    let nested: Promise<TextRasterLease> | undefined,
      writes = 0,
      deletes = 0;
    const order: string[] = [],
      primary = Error("draw retired then failed"),
      pixels = { key: "current", width: 10, height: 10, pixels: new Uint8Array(400) },
      cache = new TextRasterCache(
        {
          mask: async () => {
            throw Error("Unexpected text mask");
          },
          write: async (name) => {
            writes++;
            order.push("write");
            return "fixture:/" + name;
          },
          delete: async () => {
            deletes++;
            order.push("delete");
            nested = cache.acquirePixels(pixels);
          },
          dispose() {},
        },
        kind === "distinct" ? 800 : 400,
      );
    try {
      if (kind === "eviction") {
        const old = await cache.acquirePixels({ ...pixels, key: "old" });
        old.release();
        writes = 0;
        order.length = 0;
      }
      const outer = cache.acquirePixels({
        ...pixels,
        pixels: () => {
          if (kind === "draw" || kind === "distinct")
            nested = cache.acquirePixels({
              ...pixels,
              key: kind === "distinct" ? "other" : pixels.key,
            });
          if (kind === "retirement" || kind === "throwing-retirement") cache.dispose();
          if (kind === "throwing-retirement") throw primary;
          return pixels.pixels;
        },
      });
      if (kind === "retirement" || kind === "throwing-retirement") {
        let failure: unknown;
        try {
          await outer;
        } catch (error) {
          failure = error;
        }
        demand(
          kind === "throwing-retirement"
            ? failure === primary
            : String(failure).includes("C04_RASTER_DISPOSED"),
          "retirement must retain the draw result",
        );
        demand(writes === 0, "retired draw must not submit a file write");
        demand(
          cache.diagnostics().entries === 0 && cache.diagnostics().bytes === 0,
          "retirement must leave no entry or negative reservation",
        );
      } else {
        demand(nested !== undefined, "draw and eviction callbacks must retain synchronous timing");
        const [first, second] = await Promise.all([outer, nested!]);
        demand(
          kind === "distinct" ? first.image !== second.image : first.image === second.image,
          "same-key callers must share exactly one reserved result",
        );
        demand(writes === (kind === "distinct" ? 2 : 1), "each identity must draw once");
        demand(
          cache.diagnostics().bytes === (kind === "distinct" ? 800 : 400),
          "reservations must fit the configured byte budget",
        );
        if (kind === "eviction")
          demand(order.join(",") === "delete,write", "eviction submission must precede drawing");
        first.release();
        second.release();
      }
      results.push({ kind, writes, deletes, bytes: cache.diagnostics().bytes });
    } finally {
      cache.dispose();
    }
    demand(
      cache.diagnostics().entries === 0 && cache.diagnostics().bytes === 0,
      "full retirement must clear the cache",
    );
  }
  return results;
}
