import { RokuHostError } from "../scene/sceneGraph.types";
const table = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  table[index] = value >>> 0;
}
function crc(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = table[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function u32(value: number): number[] {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}
function chunk(name: string, data: Uint8Array): Uint8Array {
  const payload = new Uint8Array(data.length + 4),
    result = new Uint8Array(data.length + 12);
  payload.set(Array.from(name, (char) => char.charCodeAt(0)));
  payload.set(data, 4);
  result.set(u32(data.length));
  result.set(payload, 4);
  result.set(u32(crc(payload)), data.length + 8);
  return result;
}
/** Portable RGBA PNG writer using bounded stored DEFLATE blocks; no eval, Buffer or native codec. */
export function rgbaPng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (
    ![width, height].every((value) => Number.isInteger(value) && value > 0 && value <= 2048) ||
    rgba.length !== width * height * 4
  )
    throw new RokuHostError("C04_PNG", "Invalid RGBA bitmap geometry");
  const stride = width * 4,
    raw = new Uint8Array((stride + 1) * height);
  for (let row = 0; row < height; row++)
    raw.set(rgba.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  const blocks = Math.ceil(raw.length / 65535),
    zlib = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  zlib.set([0x78, 0x01]);
  let cursor = 2,
    a = 1,
    b = 0;
  for (let start = 0; start < raw.length; start += 65535) {
    const length = Math.min(65535, raw.length - start);
    zlib.set(
      [
        start + length === raw.length ? 1 : 0,
        length & 255,
        length >>> 8,
        ~length & 255,
        (~length >>> 8) & 255,
      ],
      cursor,
    );
    cursor += 5;
    zlib.set(raw.subarray(start, start + length), cursor);
    cursor += length;
  }
  for (const byte of raw) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  zlib.set(u32(((b << 16) | a) >>> 0), cursor);
  const chunks = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", Uint8Array.from([...u32(width), ...u32(height), 8, 6, 0, 0, 0])),
    chunk("IDAT", zlib),
    chunk("IEND", new Uint8Array()),
  ];
  const result = new Uint8Array(chunks.reduce((sum, value) => sum + value.length, 0));
  cursor = 0;
  for (const value of chunks) {
    result.set(value, cursor);
    cursor += value.length;
  }
  return result;
}
