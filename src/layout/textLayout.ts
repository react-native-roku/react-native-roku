import { RokuHostError } from "../scene/sceneGraph.types";
import type { LayoutStyle } from "./flexLayout";

export interface TextMetrics {
  readonly lineHeight: number;
  width(text: string): number;
}
export interface TextLayout {
  readonly text: string;
  readonly lines: readonly string[];
  readonly width: number;
  readonly height: number;
}
/** Internal capability for providers that keep ready font refs stable until disposal. */
export type RetainedFontMetrics = TextMetricProvider & {
  readRetainedFontLineHeight?(font: import("../scene/sceneGraph.types").SceneNodeRef): number;
};

export interface TextMetricProvider {
  prepare(style: LayoutStyle): void | Promise<void>;
  metrics(style: LayoutStyle): TextMetrics;
  font?(style: LayoutStyle): import("../scene/sceneGraph.types").SceneNodeRef;
  /** Ready native font whose measured glyph widths are stable for its lifetime. */
  preparedFieldFont?(style: LayoutStyle): import("../scene/sceneGraph.types").SceneNodeRef;
  fontFamily?(style: LayoutStyle): string;
  fontAsset?(style: LayoutStyle): string;
  dispose?(): void;
}

/** Yoga/SceneGraph frames use float32. A double-precision natural width can
 * exceed its own committed frame by a few millionths and falsely wrap a glyph. */
const fitsMeasuredWidth = (measured: number, available: number) =>
  Math.fround(measured) <= Math.fround(available);

function fittingPrefix(text: string, width: number, metrics: TextMetrics, suffix = ""): string {
  // UTF-16 offsets are already code-point boundaries when there are no
  // surrogates. Keep full code-point slicing for other strings.
  const points = /[\uD800-\uDFFF]/.test(text) ? Array.from(text) : undefined;
  const prefix = (length: number) =>
    points ? points.slice(0, length).join("") : text.slice(0, length);
  let low = 0,
    high = points?.length ?? text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fitsMeasuredWidth(metrics.width(prefix(middle) + suffix), width)) low = middle;
    else high = middle - 1;
  }
  return prefix(low);
}

function ellipsize(text: string, width: number, metrics: TextMetrics): string {
  if (fitsMeasuredWidth(metrics.width(text), width)) return text;
  if (!fitsMeasuredWidth(metrics.width("…"), width)) return "";
  return fittingPrefix(text, width, metrics, "…") + "…";
}

/** Uses the renderer's real font widths; it never estimates glyph widths from character count. */
export function layoutText(
  text: string,
  style: LayoutStyle,
  metrics: TextMetrics,
  maxWidth = Infinity,
  numberOfLines = 0,
): TextLayout {
  const spacing = Number(style.letterSpacing ?? 0);
  if (!Number.isFinite(spacing))
    throw new RokuHostError("C04_LETTER_SPACING", "Letter spacing must be finite");
  if (spacing) {
    const original = metrics;
    metrics = {
      lineHeight: original.lineHeight,
      width: (value) =>
        Math.max(0, original.width(value) + Math.max(0, Array.from(value).length - 1) * spacing),
    };
  }
  if (style.textTransform === "uppercase") text = text.toUpperCase();
  else if (style.textTransform === "lowercase") text = text.toLowerCase();
  else if (style.textTransform === "capitalize")
    text = text.replace(
      /(^|\s)(\S)/gu,
      (_match, space: string, character: string) => space + character.toUpperCase(),
    );
  else if (style.textTransform != null && style.textTransform !== "none")
    throw new RokuHostError(
      "C04_TEXT_TRANSFORM",
      `Text transform ${String(style.textTransform)} needs conformance`,
    );
  const lineHeight = typeof style.lineHeight === "number" ? style.lineHeight : metrics.lineHeight;
  if (!(lineHeight > 0) || !Number.isFinite(lineHeight) || maxWidth < 0 || Number.isNaN(maxWidth))
    throw new RokuHostError("C04_TEXT_METRICS", "Text requires valid width and line height");
  if (!Number.isInteger(numberOfLines) || numberOfLines < 0)
    throw new RokuHostError("C04_TEXT_LINES", "numberOfLines must be a nonnegative integer");
  const paragraphs = text.replaceAll("\r\n", "\n").split("\n");
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    if (!Number.isFinite(maxWidth) || fitsMeasuredWidth(metrics.width(paragraph), maxWidth)) {
      lines.push(paragraph);
      continue;
    }
    if (numberOfLines === 1) {
      lines.push(ellipsize(paragraphs.join(" "), maxWidth, metrics));
      break;
    }
    let remaining = paragraph;
    while (remaining.length) {
      const fitting = fittingPrefix(remaining, maxWidth, metrics);
      if (!fitting) {
        lines.push("");
        break;
      }
      const boundary = fitting.search(/\s+\S*$/u);
      const line =
        boundary > 0 && fitting.length < remaining.length ? fitting.slice(0, boundary) : fitting;
      lines.push(line.trimEnd());
      remaining = remaining.slice(line.length).trimStart();
    }
  }
  if (numberOfLines && lines.length > numberOfLines) {
    const truncated = lines.slice(0, numberOfLines);
    // The omitted continuation requires an ellipsis even if this line happened to fit.
    truncated[numberOfLines - 1] = ellipsize(
      truncated[numberOfLines - 1] + " …",
      maxWidth,
      metrics,
    );
    return result(truncated, lineHeight, metrics);
  }
  return result(lines, lineHeight, metrics);
}

function result(lines: string[], lineHeight: number, metrics: TextMetrics): TextLayout {
  return {
    text: lines.join("\n"),
    lines,
    width: Math.max(0, ...lines.map((line) => metrics.width(line))),
    height: Math.max(1, lines.length) * lineHeight,
  };
}
