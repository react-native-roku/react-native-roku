import { inflateSync } from "node:zlib";
import { expect, it } from "vitest";
import { gaussianAlpha, paintTextMask } from "./rasterPixels";
import { rgbaPng } from "./png";
import { decodeBase64, encodeBase64 } from "../services/base64";

it("preserves Gaussian mask energy and symmetry without clamping transparent edges", () => {
  const mask = new Uint8Array(21 * 21);
  mask[10 * 21 + 10] = 255;
  const blurred = gaussianAlpha(mask, 21, 21, 4);
  expect(blurred.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 6);
  expect(blurred[10 * 21 + 8]).toBeCloseTo(blurred[10 * 21 + 12]);
  expect(blurred[10 * 21 + 10]).toBeGreaterThan(blurred[10 * 21 + 8]);
  expect(blurred[0]).toBe(0);
  const edge = new Uint8Array(9);
  edge[0] = 255;
  expect(gaussianAlpha(edge, 3, 3, 4).reduce((sum, value) => sum + value, 0)).toBeLessThan(1);
});

it("composites whole-mask shadows behind ink and translates fractional offsets", () => {
  const mask = Uint8Array.from([0, 255, 0, 0]);
  const pixels = paintTextMask(mask, 4, 1, "0xFFFFFFFF", "0x000000FF", 0, 0.5, 0);
  expect([...pixels.subarray(4, 8)]).toEqual([255, 255, 255, 255]);
  expect([...pixels.subarray(8, 12)]).toEqual([0, 0, 0, 128]);
  expect([...pixels.subarray(12)]).toEqual([0, 0, 0, 0]);
});

it("writes valid PNG scanlines across multiple stored DEFLATE blocks", () => {
  const width = 137,
    height = 163,
    pixels = Uint8Array.from({ length: width * height * 4 }, (_, index) => (index * 19) & 255);
  const png = rgbaPng(width, height, pixels),
    view = new DataView(png.buffer);
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const compressed: Uint8Array[] = [];
  for (let offset = 8; offset < png.length;) {
    const size = view.getUint32(offset),
      name = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    if (name === "IDAT") compressed.push(png.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const raw = inflateSync(Buffer.concat(compressed));
  for (let row = 0; row < height; row++) {
    const at = row * (width * 4 + 1);
    expect(raw[at]).toBe(0);
    expect(new Uint8Array(raw.subarray(at + 1, at + 1 + width * 4))).toEqual(
      pixels.subarray(row * width * 4, (row + 1) * width * 4),
    );
  }
});

it("round-trips binary payloads and rejects corrupt/noncanonical base64", () => {
  for (const length of [0, 1, 2, 3, 31, 8193, 65539]) {
    const bytes = Uint8Array.from({ length }, (_, index) => (index * 37) & 255);
    const encoded = encodeBase64(bytes);
    expect(encoded).toBe(Buffer.from(bytes).toString("base64"));
    expect(decodeBase64(encoded)).toEqual(bytes);
  }
  for (const encoded of ["a", "====", "AB==", "AAA=\n", "AAB=", "AAAA="])
    expect(() => decodeBase64(encoded)).toThrow("C04_RASTER_ENCODING");
});
