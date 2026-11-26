import { RokuHostError } from "../scene/sceneGraph.types";
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  let part = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index],
      b = bytes[index + 1],
      c = bytes[index + 2],
      value = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    part +=
      alphabet[value >>> 18] +
      alphabet[(value >>> 12) & 63] +
      (b == null ? "=" : alphabet[(value >>> 6) & 63]) +
      (c == null ? "=" : alphabet[value & 63]);
    if (part.length >= 8192) {
      chunks.push(part);
      part = "";
    }
  }
  chunks.push(part);
  return chunks.join("");
}
export function decodeBase64(value: string): Uint8Array {
  if (value.length % 4)
    throw new RokuHostError("C04_RASTER_ENCODING", "Invalid raster base64 encoding");
  const result = new Uint8Array(
    (value.length / 4) * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0),
  );
  let cursor = 0;
  for (let index = 0; index < value.length; index += 4) {
    const a = alphabet.indexOf(value[index]),
      b = alphabet.indexOf(value[index + 1]),
      c = alphabet.indexOf(value[index + 2]),
      d = alphabet.indexOf(value[index + 3]);
    const last = index + 4 === value.length;
    if (
      a < 0 ||
      b < 0 ||
      (c < 0 && !(last && value[index + 2] === "=" && value[index + 3] === "=")) ||
      (d < 0 && !(last && value[index + 3] === "="))
    )
      throw new RokuHostError("C04_RASTER_ENCODING", "Invalid raster base64 encoding");
    if ((c < 0 && b & 15) || (d < 0 && c >= 0 && c & 3))
      throw new RokuHostError("C04_RASTER_ENCODING", "Noncanonical raster base64 padding");
    const bits = (a << 18) | (b << 12) | (Math.max(0, c) << 6) | Math.max(0, d);
    if (cursor < result.length) result[cursor++] = bits >>> 16;
    if (cursor < result.length) result[cursor++] = bits >>> 8;
    if (cursor < result.length) result[cursor++] = bits;
  }
  return result;
}
