/** UTF-8 bytes for device encryption, independent of optional firmware TextEncoder globals. */
export function encodeUtf8(value: string): Uint8Array {
  const bytes: number[] = [];
  for (const character of value) {
    let point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) point = 0xfffd;
    if (point < 0x80) bytes.push(point);
    else if (point < 0x800) bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    else if (point < 0x10000)
      bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    else
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f),
      );
  }
  return new Uint8Array(bytes);
}
export function decodeUtf8(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index++];
    let point = first,
      count = 0,
      minimum = 0;
    if (first >= 0xc2 && first <= 0xdf) {
      count = 1;
      point = first & 0x1f;
      minimum = 0x80;
    } else if (first >= 0xe0 && first <= 0xef) {
      count = 2;
      point = first & 0x0f;
      minimum = 0x800;
    } else if (first >= 0xf0 && first <= 0xf4) {
      count = 3;
      point = first & 7;
      minimum = 0x10000;
    } else if (first >= 0x80) throw new Error("Invalid UTF-8 credential bytes");
    for (let next = 0; next < count; next++) {
      const byte = bytes[index++];
      if (byte == null || (byte & 0xc0) !== 0x80) throw new Error("Invalid UTF-8 credential bytes");
      point = (point << 6) | (byte & 0x3f);
    }
    if (point < minimum || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff))
      throw new Error("Invalid UTF-8 credential bytes");
    result += String.fromCodePoint(point);
  }
  return result;
}
export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
export function fromHex(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(value)) throw new Error("Invalid encrypted credential encoding");
  return new Uint8Array(value.match(/../g)?.map((pair) => parseInt(pair, 16)) ?? []);
}
