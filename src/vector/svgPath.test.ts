import { expect, it } from "vitest";
import { svgPath } from "./svgPath";
import { svgPixels } from "./svgPixels";
import { roundedBorderPixels } from "../graphics/RoundedBorder";

it("flattens relative paths, cubic and reflected quadratic curves, and elliptical arcs", () => {
  expect(svgPath("M1e1,-2h3v4z")[0]).toEqual([
    [10, -2],
    [13, -2],
    [13, 2],
    [10, -2],
  ]);
  const cubic = svgPath("M0 0C0 10 10 10 10 0")[0];
  expect(cubic.at(-1)).toEqual([10, 0]);
  expect(Math.max(...cubic.map((point) => point[1]))).toBeCloseTo(7.5);
  const reflected = svgPath("M0 0Q10 10 20 0T40 0")[0];
  expect(reflected.at(-1)).toEqual([40, 0]);
  expect(Math.min(...reflected.map((point) => point[1]))).toBeCloseTo(-5);
  const arc = svgPath("M10 0A10 10 0 1 1 -10 0Z")[0];
  expect(arc.some(([x, y]) => Math.abs(x) < 0.01 && y > 9.99)).toBe(true);
  expect(arc.at(-1)).toEqual([10, 0]);
  expect(() => svgPath("M0 0 C nope")).toThrow(/coordinate/);
  expect(() => svgPath("M0 0 A10 10 0 3 1 5 5")).toThrow(/flags/);
  expect(() => svgPath("M0 0!")).toThrow(/Invalid/);
});

it("preserves holes, alpha composition and open strokes in portable SVG pixels", () => {
  const ring = svgPath("M0 0H10V10H0ZM3 3V7H7V3Z");
  const pixels = svgPixels(10, 10, [
    { paths: ring, fill: "red" },
    { paths: svgPath("M0 0H3V3H0Z"), fill: "blue", opacity: 0.5 },
  ]);
  const at = (x: number, y: number) => [...pixels.slice((y * 10 + x) * 4, (y * 10 + x + 1) * 4)];
  expect(at(5, 5)[3]).toBe(0);
  expect(at(8, 8)).toEqual([255, 0, 0, 255]);
  expect(at(1, 1)).toEqual([128, 0, 128, 255]);
  const stroke = svgPixels(10, 10, [
    {
      paths: svgPath("M1 3.5H9"),
      fill: "none",
      stroke: "white",
      strokeWidth: 1,
    },
  ]);
  expect(stroke[(3 * 10 + 5) * 4 + 3]).toBe(255);
  expect(stroke[(7 * 10 + 5) * 4 + 3]).toBe(0);
  expect(() => svgPixels(4096, 1, [])).toThrow(/budget/);
});

it("paints an asymmetric rounded border without filling its interior or square corners", () => {
  const pixels = roundedBorderPixels(
    { borderRadius: 6, borderTopWidth: 2, borderColor: "red" },
    20,
    16,
  );
  const alpha = (x: number, y: number) => pixels[(y * 20 + x) * 4 + 3];
  expect(alpha(10, 0)).toBe(255);
  expect(alpha(10, 5)).toBe(0);
  expect(alpha(10, 15)).toBe(0);
  expect(alpha(0, 0)).toBe(0);
  expect(() =>
    roundedBorderPixels({ borderWidth: 2, borderLeftColor: "blue", borderColor: "red" }, 20, 16),
  ).toThrow(/Multicolor/);
});
