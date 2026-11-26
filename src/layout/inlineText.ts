import type { SceneTreeElement } from "../renderer/SceneRoot";
import type { LayoutStyle } from "./flexLayout";
import { layoutText, type TextMetricProvider } from "./textLayout";
import { RokuHostError } from "../scene/sceneGraph.types";
export interface InlineTextRun {
  readonly text: string;
  readonly style: LayoutStyle;
}
export function inlineTextRuns(
  node: SceneTreeElement,
  inherited: LayoutStyle = {},
): InlineTextRun[] {
  if (!["label", "multiStyleLabel", "inlineText", "poster"].includes(node.type))
    throw new RokuHostError("C04_INLINE_CONTENT", "Inline text admits text runs only");
  const style = {
      ...inherited,
      ...((node.props.layout?.style as LayoutStyle) ?? {}),
    },
    runs: InlineTextRun[] = [];
  const scalar = node.props.layout?.scalarText;
  if (typeof scalar === "string" && scalar !== "") return [{ text: scalar, style }];
  for (const child of node.children) {
    if (child.kind === "text") {
      if (!child.hidden) runs.push({ text: child.text, style });
    } else runs.push(...inlineTextRuns(child, style));
  }
  return runs;
}
export function measureInlineText(
  runs: readonly InlineTextRun[],
  text: TextMetricProvider,
  maximumWidth: number | undefined,
  numberOfLines: number,
  raster = false,
) {
  let width = 0,
    height = 0;
  for (const [index, run] of runs.entries()) {
    if (
      !raster &&
      (Number(run.style.letterSpacing ?? 0) ||
        run.style.textShadowColor != null ||
        run.style.textShadowRadius != null)
    )
      throw new RokuHostError(
        "C04_INLINE_RASTER",
        "Tracked or shadowed mixed text requires the multi-run raster adapter",
      );
    if (run.text.includes("\n"))
      throw new RokuHostError(
        "C04_INLINE_WRAP",
        "Multiline mixed text requires inline line shaping",
      );
    const metrics = text.metrics(run.style);
    width += raster
      ? layoutText(run.text, run.style, metrics, Infinity, 1).width +
        (index < runs.length - 1 ? Number(run.style.letterSpacing ?? 0) : 0)
      : metrics.width(run.text);
    height = Math.max(height, Number(run.style.lineHeight ?? metrics.lineHeight));
  }
  if (
    (raster || numberOfLines !== 1) &&
    maximumWidth != null &&
    Math.fround(width) > Math.fround(maximumWidth)
  )
    throw new RokuHostError("C04_INLINE_WRAP", "Wrapped mixed text requires inline line shaping");
  return { width: Math.min(width, maximumWidth ?? Infinity), height };
}
