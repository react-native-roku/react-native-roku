import { describe, expect, it } from "vitest";
import { calculateFlexLayout, type LayoutInput, type LayoutStyle } from "./flexLayout";

const node = (style: LayoutStyle, children: LayoutInput[] = [], text?: string): LayoutInput => ({
  style,
  children,
  text,
});
const viewport = { width: 1000, height: 600 };

describe("P02 admitted flex layout (host evidence)", () => {
  it("stretches absolute insets and lets physical sides override shorthand regardless of property order", () => {
    for (const style of [
      { left: 9, top: 7, inset: 5 },
      { inset: 5, top: 7, left: 9 },
    ]) {
      const child = node({ position: "absolute", ...style });
      const layout = calculateFlexLayout(node({}, [child]), { width: 100, height: 200 });
      expect(layout.get(child)).toEqual({ x: 9, y: 7, width: 86, height: 188 });
    }
  });
  it("resolves axis/edge inset aliases and percentage geometry against the containing block", () => {
    const child = node({
      position: "absolute",
      inset: 1,
      insetInline: "10%",
      insetBlock: "5%",
      start: 3,
      insetInlineStart: 8,
      top: 7,
      insetBlockStart: 99,
      insetBlockEnd: 12,
    });
    const layout = calculateFlexLayout(node({}, [child]), { width: 100, height: 200 });
    expect(layout.get(child)).toEqual({ x: 8, y: 7, width: 82, height: 181 });
  });
  it("retains negative inset overflow and rejects invalid inset values", () => {
    const child = node({ position: "absolute", inset: -5 });
    expect(calculateFlexLayout(node({}, [child]), { width: 100, height: 200 }).get(child)).toEqual({
      x: -5,
      y: -5,
      width: 110,
      height: 210,
    });
    expect(() => calculateFlexLayout(node({}, [node({ inset: NaN })]), viewport)).toThrow(
      /C03_LAYOUT_VALUE/,
    );
  });
  it("admits explicit automatic flex bases and Yoga's view baseline alignment", () => {
    const first = node({ width: 80, height: 20, flexBasis: "auto" }),
      second = node({ width: 100, height: 40, flexBasis: "auto" });
    const layout = calculateFlexLayout(
      node({ flexDirection: "row", alignItems: "baseline" }, [first, second]),
      viewport,
    );
    expect(layout.get(first)).toEqual({ x: 0, y: 20, width: 80, height: 20 });
    expect(layout.get(second)).toEqual({ x: 80, y: 0, width: 100, height: 40 });
  });
  it("lays out padding, explicit margins, gap and flex growth from independently expected geometry", () => {
    const fixed = node({ width: 100, height: 40, marginRight: 5 }),
      grow = node({ flex: 1, height: 40 });
    const root = node({ flexDirection: "row", padding: 20, gap: 10 }, [fixed, grow]);
    const layout = calculateFlexLayout(root, viewport);
    expect(layout.get(fixed)).toEqual({ x: 20, y: 20, width: 100, height: 40 });
    expect(layout.get(grow)).toEqual({ x: 135, y: 20, width: 845, height: 40 });
  });

  it("excludes hidden and absolute children from gap placement", () => {
    const first = node({ height: 30 }),
      hidden = node({ display: "none", height: 100 }),
      overlay = node({
        position: "absolute",
        top: 5,
        right: 10,
        width: "25%",
        height: 20,
      }),
      last = node({ height: 40 });
    const layout = calculateFlexLayout(node({ gap: 15 }, [first, hidden, overlay, last]), viewport);
    expect(layout.get(last)?.y).toBe(45);
    expect(layout.get(overlay)).toEqual({
      x: 740,
      y: 5,
      width: 250,
      height: 20,
    });
    expect(layout.get(hidden)?.height).toBe(0);
  });

  it("retains nested collection geometry and computes text with an explicit metric port", () => {
    const title = node({ maxWidth: 300 }, [], "A measured title");
    const card = node({ width: 180, height: 260 });
    const row = node({ flexDirection: "row", gap: 12 }, [card]);
    const layout = calculateFlexLayout(
      node({ padding: 24, gap: 16 }, [title, row]),
      viewport,
      (entry, width) => ({
        width: Math.min(entry.text!.length * 10, width ?? Infinity),
        height: 28,
      }),
    );
    expect(layout.get(title)?.height).toBe(28);
    expect(layout.get(row)?.y).toBe(68);
    expect(layout.get(card)).toEqual({ x: 0, y: 0, width: 180, height: 260 });
  });

  it("refuses invalid metrics, unsupported wrapped gaps and dimensions rather than fabricating layout", () => {
    expect(() => calculateFlexLayout(node({}, [], "text"), viewport)).toThrow(/C04_TEXT_METRICS/);
    expect(() =>
      calculateFlexLayout(
        node({ flexWrap: "wrap", alignContent: "space-between", gap: 8 }),
        viewport,
      ),
    ).toThrow(/C03_WRAP_GAP/);
    expect(() => calculateFlexLayout(node({ width: "calc(100% - 20px)" }), viewport)).toThrow(
      /C03_LAYOUT_VALUE/,
    );
    expect(() =>
      calculateFlexLayout(node({}, [node({}, [], "text")]), viewport, () => ({
        width: NaN,
        height: 1,
      })),
    ).toThrow(/C04_TEXT_METRICS/);
  });

  it("releases partially built layout trees after a rejected child and can continue rendering", () => {
    for (let index = 0; index < 100; index++) {
      expect(() =>
        calculateFlexLayout(node({}, [node({}), node({ width: "unsupported" })]), viewport),
      ).toThrow();
    }
    const child = node({ width: 80, height: 90 });
    expect(calculateFlexLayout(node({}, [child]), viewport).get(child)).toEqual({
      x: 0,
      y: 0,
      width: 80,
      height: 90,
    });
  });
  it("wraps intrinsic rows with gutters, exact-fit edges, padding and no trailing height", () => {
    const a = node({ width: 40, height: 20 }),
      b = node({ width: 40, height: 30 }),
      c = node({ width: 40, height: 20 });
    const row = node(
      {
        width: 110,
        padding: 5,
        flexDirection: "row",
        flexWrap: "wrap",
        columnGap: 10,
        rowGap: 8,
      },
      [a, b, c],
    );
    const layout = calculateFlexLayout(node({}, [row]), viewport);
    expect(layout.get(row)).toEqual({ x: 0, y: 0, width: 110, height: 68 });
    expect(layout.get(a)).toEqual({ x: 5, y: 5, width: 40, height: 20 });
    expect(layout.get(b)).toEqual({ x: 55, y: 5, width: 40, height: 30 });
    expect(layout.get(c)).toEqual({ x: 5, y: 43, width: 40, height: 20 });
    const first = node({ width: 50, height: 20 }),
      second = node({ width: 50, height: 20 });
    const exact = node({ width: 110, flexDirection: "row", flexWrap: "wrap", gap: 10 }, [
      first,
      second,
    ]);
    const fitted = calculateFlexLayout(node({}, [exact]), viewport);
    expect(fitted.get(second)?.x).toBe(60);
    expect(fitted.get(second)?.y).toBe(0);
    expect(fitted.get(exact)?.height).toBe(20);
  });
  it("keeps wrapped percentages relative to the original content box and distributes flex growth", () => {
    const a = node({ width: "50%", height: 20 }),
      b = node({ width: "50%", height: 20 });
    const row = node(
      {
        width: 110,
        padding: 5,
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 10,
      },
      [a, b],
    );
    const layout = calculateFlexLayout(node({}, [row]), viewport);
    expect(layout.get(a)).toEqual({ x: 5, y: 5, width: 50, height: 20 });
    expect(layout.get(b)).toEqual({ x: 5, y: 35, width: 50, height: 20 });
    const growA = node({ width: 40, height: 20, flexGrow: 1 }),
      growB = node({ width: 40, height: 20, flexGrow: 1 });
    const grown = calculateFlexLayout(
      node({}, [
        node({ width: 100, flexDirection: "row", flexWrap: "wrap", gap: 10 }, [growA, growB]),
      ]),
      viewport,
    );
    expect(grown.get(growA)?.width).toBe(45);
    expect(grown.get(growB)?.x).toBe(55);
    expect(grown.get(growB)?.width).toBe(45);
  });
});
