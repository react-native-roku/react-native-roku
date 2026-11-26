import type { InlineTextRun } from "./inlineText";
import { layoutText, type TextMetricProvider } from "./textLayout";
import { RokuHostError } from "../scene/sceneGraph.types";

export interface InlineTextLine {
  readonly runs: readonly InlineTextRun[];
  readonly width: number;
  readonly height: number;
  readonly paintHeight: number;
  readonly y: number;
}

/** Attributed line breaks use whole-run font measurements, retaining kerning
 * inside each styled run. Native styled labels own shaping within each line. */
export function layoutInlineParagraph(
  source: readonly InlineTextRun[],
  provider: TextMetricProvider,
  maximumWidth = Infinity,
  numberOfLines = 0,
) {
  if (source.length > 64)
    throw new RokuHostError("C04_INLINE_RUNS", "Mixed text supports at most 64 runs");
  if (maximumWidth < 0 || Number.isNaN(maximumWidth))
    throw new RokuHostError("C04_TEXT_METRICS", "Mixed text requires a valid width");
  if (!Number.isInteger(numberOfLines) || numberOfLines < 0)
    throw new RokuHostError("C04_TEXT_LINES", "numberOfLines must be a nonnegative integer");
  if (!source.length) return { lines: [], width: 0, height: 0, truncated: false };
  const runs = source.map((run) => {
    if (
      Number(run.style.letterSpacing ?? 0) ||
      run.style.textShadowColor != null ||
      run.style.textShadowRadius != null
    )
      throw new RokuHostError(
        "C04_INLINE_RASTER",
        "Tracked or shadowed mixed text requires the multi-run raster adapter",
      );
    const metrics = provider.metrics(run.style);
    return { ...run, text: layoutText(run.text, run.style, metrics).text };
  });
  const metrics = new Map(runs.map((run) => [run.style, provider.metrics(run.style)]));
  const points = runs.flatMap((run) =>
    Array.from(run.text, (value) => ({ value, style: run.style })),
  );
  if (points.length > 32768)
    throw new RokuHostError("C04_INLINE_SIZE", "A mixed paragraph exceeds 32768 code points");
  const fits = (width: number) => Math.fround(width) <= Math.fround(maximumWidth);
  const widthOf = (fragments: readonly InlineTextRun[]) =>
    fragments.reduce((sum, run) => {
      const width = metrics.get(run.style)!.width(run.text);
      if (!Number.isFinite(width) || width < 0)
        throw new RokuHostError("C04_FONT_METRICS", "Mixed text received an invalid font width");
      return sum + width;
    }, 0);
  type Fragment = { text: string; style: InlineTextRun["style"] };
  const fragments = (start: number, end: number): Fragment[] => {
    const result: { text: string; style: InlineTextRun["style"] }[] = [];
    for (let index = start; index < end; index++) {
      const point = points[index],
        previous = result.at(-1);
      if (previous?.style === point.style) previous.text += point.value;
      else result.push({ text: point.value, style: point.style });
    }
    return result;
  };
  const raw: Fragment[][] = [];
  const add = (start: number, end: number) => {
    if (raw.length >= 512)
      throw new RokuHostError("C04_INLINE_LINES", "A mixed paragraph exceeds 512 native lines");
    raw.push(fragments(start, end));
  };
  if (maximumWidth === 0) raw.push([]);
  else if (numberOfLines === 1) {
    raw.push(runs.map((run) => ({ ...run, text: run.text.replaceAll("\n", " ") })));
  } else {
    let start = 0;
    for (let paragraphEnd = 0; paragraphEnd <= points.length; paragraphEnd++) {
      if (paragraphEnd < points.length && points[paragraphEnd].value !== "\n") continue;
      if (start === paragraphEnd) add(start, start);
      while (start < paragraphEnd) {
        if (fits(widthOf(fragments(start, paragraphEnd)))) {
          add(start, paragraphEnd);
          break;
        }
        let low = 0,
          high = paragraphEnd - start;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (fits(widthOf(fragments(start, start + middle)))) low = middle;
          else high = middle - 1;
        }
        // Consume a code point even when no glyph fits, so a narrow constraint
        // cannot stall layout. The one-line native leaf clips that glyph.
        let end = start + Math.max(1, low);
        if (low && !/\s/u.test(points[end]?.value ?? "")) {
          for (let index = end - 1; index > start; index--) {
            if (/\s/u.test(points[index].value)) {
              end = index;
              break;
            }
            if (points[index].value === "-") {
              end = index + 1;
              break;
            }
          }
        }
        let visibleEnd = end;
        while (visibleEnd > start && /\s/u.test(points[visibleEnd - 1].value)) visibleEnd--;
        add(start, visibleEnd);
        start = end;
        while (start < paragraphEnd && /\s/u.test(points[start].value)) start++;
      }
      start = paragraphEnd + 1;
    }
  }
  const truncated =
    (numberOfLines > 0 && raw.length > numberOfLines) ||
    (numberOfLines === 1 && !fits(widthOf(raw[0])));
  if (truncated) {
    raw.splice(numberOfLines);
    const last = raw.at(-1)!;
    while (last.length) {
      const tail = last.at(-1)!;
      tail.text = tail.text.trimEnd();
      if (tail.text) break;
      last.pop();
    }
    while (true) {
      const style = last.at(-1)?.style ?? runs[0].style;
      const ellipsis = { text: "…", style };
      if (fits(widthOf([...last, ellipsis]))) {
        last.push(ellipsis);
        break;
      }
      const tail = last.at(-1);
      if (!tail) break;
      tail.text = Array.from(tail.text).slice(0, -1).join("");
      if (!tail.text) last.pop();
    }
  }
  let y = 0;
  const lines: InlineTextLine[] = raw.map((fragments) => {
    const styles = fragments.length ? fragments.map((run) => run.style) : [runs[0].style];
    const height = Math.max(
      ...styles.map((style) => Number(style.lineHeight ?? metrics.get(style)!.lineHeight)),
    );
    const paintHeight = Math.max(height, ...styles.map((style) => metrics.get(style)!.lineHeight));
    const line = { runs: fragments, width: widthOf(fragments), height, paintHeight, y };
    y += height;
    return line;
  });
  return {
    lines,
    width: Math.min(maximumWidth, Math.max(0, ...lines.map((line) => line.width))),
    height: y,
    truncated,
  };
}
