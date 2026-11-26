import { expect, it } from "vitest";
import { decodeBase64, encodeBase64 } from "./base64";

it("decodes a full-size native text mask without a whole-payload regexp stack", () => {
  const bytes = Uint8Array.from({ length: 2048 * 512 * 4 }, (_, index) => index % 251);
  const encoded = encodeBase64(bytes);
  expect(encoded).toBe(Buffer.from(bytes).toString("base64"));
  expect(Buffer.from(decodeBase64(encoded)).equals(Buffer.from(bytes))).toBe(true);
});
it("rejects misplaced, noncanonical and nonalphabet padding", () => {
  for (const value of [
    "a",
    "=AAA",
    "A=AA",
    "AA=A",
    "AAAA====",
    "AA==AAAA",
    "AB==",
    "AAB=",
    "AA?=",
    "AAA\n",
  ])
    expect(() => decodeBase64(value)).toThrow();
  expect([...decodeBase64("AA==")]).toEqual([0]);
  expect([...decodeBase64("AAA=")]).toEqual([0, 0]);
  expect([...decodeBase64("")]).toEqual([]);
});
