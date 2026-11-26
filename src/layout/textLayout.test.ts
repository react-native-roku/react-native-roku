import { describe, expect, it } from "vitest";
import { layoutText, type TextMetrics } from "./textLayout";

const metrics: TextMetrics = {
  lineHeight: 20,
  width: (text) =>
    Array.from(text).reduce((sum, char) => sum + (char === "i" ? 2 : char === " " ? 4 : 8), 0),
};

describe("P02 text layout consumes supplied font metrics", () => {
  it("keeps a measured word on one line after Yoga rounds its own natural width to float32", () => {
    const measured: TextMetrics = {
      lineHeight: 21,
      width: (text) => text.length * 8.469189453125,
    };
    const naturalWidth = measured.width("Advanced") + 0.7;
    const frameWidth = Math.fround(naturalWidth);
    expect(frameWidth).toBeLessThan(naturalWidth);
    expect(layoutText("Advanced", { letterSpacing: 0.1 }, measured, frameWidth)).toMatchObject({
      lines: ["Advanced"],
      height: 21,
    });
    expect(layoutText("Advanced", { letterSpacing: 0.1 }, measured, frameWidth, 1).text).toBe(
      "Advanced",
    );
    expect(
      layoutText("Advanced", { letterSpacing: 0.1 }, measured, frameWidth - 1).lines.length,
    ).toBeGreaterThan(1);
  });
  it("uses authored tracking for wrapping and ellipsis", () => {
    expect(layoutText("abc", { letterSpacing: 2 }, metrics).width).toBe(28);
    expect(layoutText("abcd", { letterSpacing: 2 }, metrics, 30, 1).text).toBe("ab…");
  });
  it("wraps at word boundaries using unequal glyph widths", () => {
    const value = layoutText("wide iii next", {}, metrics, 48);
    expect(value.lines).toEqual(["wide iii", "next"]);
    expect(metrics.width(value.lines[0])).toBe(36);
  });
  it("preserves newlines and uses an explicitly authored line height", () => {
    expect(layoutText("first\n\nlast", { lineHeight: 24 }, metrics)).toMatchObject({
      lines: ["first", "", "last"],
      height: 72,
    });
  });
  it("ellipsizes one-line text at a code-point boundary", () => {
    const value = layoutText("abcd😀", {}, metrics, 32, 1);
    expect(value.text).toBe("abc…");
    expect(value.width).toBeLessThanOrEqual(32);
  });
  it("keeps surrogate pairs intact across a word break and a narrow wrap", () => {
    expect(layoutText("🏔️ na😀 😀é", {}, metrics, 28).lines).toEqual(["🏔️", "na😀", "😀é"]);
    expect(layoutText("😀😀😀", {}, metrics, 8).lines).toEqual(["😀", "😀", "😀"]);
  });
  it("bounds line count and exposes an omitted continuation", () => {
    const value = layoutText("one two three four five", {}, metrics, 40, 2);
    expect(value.lines).toHaveLength(2);
    expect(value.lines[1]).toContain("…");
    expect(value.width).toBeLessThanOrEqual(40);
  });
  it("terminates for a viewport narrower than one glyph", () => {
    expect(layoutText("wide", {}, metrics, 1)).toMatchObject({
      width: 0,
      height: 20,
    });
  });
});
