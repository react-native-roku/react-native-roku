import { expect, it } from "vitest";
import { layoutInlineParagraph } from "./inlineParagraph";
import type { LayoutStyle } from "./flexLayout";

const provider = {
  prepare() {},
  metrics: () => ({ lineHeight: 20, width: (text: string) => Array.from(text).length * 10 }),
};
const values = (layout: ReturnType<typeof layoutInlineParagraph>) =>
  layout.lines.map((line) => line.runs.map((run) => run.text).join(""));

it("breaks words across style boundaries and handles newlines, long words and hyphens", () => {
  const normal = {},
    red = { color: "red" };
  expect(
    values(
      layoutInlineParagraph(
        [
          { text: "one tw", style: normal },
          { text: "o three", style: red },
        ],
        provider,
        50,
      ),
    ),
  ).toEqual(["one", "two", "three"]);
  expect(
    values(layoutInlineParagraph([{ text: "ab-cdef\n\nxyz", style: normal }], provider, 40)),
  ).toEqual(["ab-", "cdef", "", "xyz"]);
  expect(values(layoutInlineParagraph([{ text: "A😀BC", style: normal }], provider, 20))).toEqual([
    "A😀",
    "BC",
  ]);
  expect(values(layoutInlineParagraph([{ text: "X", style: normal }], provider, 1))).toEqual(["X"]);
  expect(values(layoutInlineParagraph([{ text: "X", style: normal }], provider, 0))).toEqual([""]);
  expect(layoutInlineParagraph([], provider, 100)).toMatchObject({
    lines: [],
    width: 0,
    height: 0,
  });
});

it("retains whole-run kerning and accepts its own float32 natural width", () => {
  const font = {
    prepare() {},
    metrics: () => ({
      lineHeight: 20,
      width: (text: string) => (text === "AV" ? 17.0000001 : text.length * 10),
    }),
  };
  const result = layoutInlineParagraph([{ text: "AV", style: {} }], font, Math.fround(17.0000001));
  expect(values(result)).toEqual(["AV"]);
  expect(result.height).toBe(20);
});

it("transforms each styled run and keeps the ellipsis in the final retained style", () => {
  const style = { textTransform: "uppercase", color: "red" } satisfies LayoutStyle;
  const result = layoutInlineParagraph([{ text: "aa bb cc", style }], provider, 25, 2);
  expect(values(result)).toEqual(["AA", "B…"]);
  expect(result.lines[1].runs.at(-1)?.style).toBe(style);
  expect(result).toMatchObject({ truncated: true, height: 40 });
  expect(values(layoutInlineParagraph([{ text: "abcdef", style }], provider, 25, 1))).toEqual([
    "A…",
  ]);
});

it("refuses invalid constraints, unsupported raster effects and oversized native line inventories", () => {
  expect(() => layoutInlineParagraph([{ text: "x", style: {} }], provider, -1)).toThrow(
    "C04_TEXT_METRICS",
  );
  expect(() => layoutInlineParagraph([{ text: "x", style: {} }], provider, 10, 1.5)).toThrow(
    "C04_TEXT_LINES",
  );
  expect(() =>
    layoutInlineParagraph([{ text: "x", style: { letterSpacing: 1 } }], provider, 10),
  ).toThrow("C04_INLINE_RASTER");
  expect(() =>
    layoutInlineParagraph([{ text: "x\n".repeat(513), style: {} }], provider, 10),
  ).toThrow("C04_INLINE_LINES");
  expect(() =>
    layoutInlineParagraph([{ text: "x".repeat(32769), style: {} }], provider, 100),
  ).toThrow("C04_INLINE_SIZE");
});
