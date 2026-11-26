import type { LayoutRect, LayoutStyle } from "./flexLayout";
import { layoutText, type TextLayout, type TextMetricProvider } from "./textLayout";
import type { SceneTreeElement } from "../renderer/SceneRoot";
import { RokuHostError, type SceneFields, type SceneValue } from "../scene/sceneGraph.types";
import { rokuColor } from "../react-native/styleSheet";
import { sceneTransform } from "./transform";
import { sceneNodeReference } from "../renderer/SceneRoot";
import { inlineTextRuns } from "./inlineText";
import { layoutInlineParagraph } from "./inlineParagraph";

export function labelText(node: SceneTreeElement): string {
  const scalar = node.props.layout?.scalarText;
  if (typeof scalar === "string") return scalar;
  if (node.children.some((child) => child.kind === "element"))
    throw new RokuHostError("C04_TEXT_RUNS", "Nested styled text requires an inline-text renderer");
  return node.children.length
    ? node.children
        .map((child) => (child.kind === "text" && !child.hidden ? child.text : ""))
        .join("")
    : String(node.props.fields?.text ?? "");
}

export interface MeasuredLabel {
  readonly width: number | undefined;
  readonly lineHeight: number;
  readonly layout: TextLayout;
}

export function nativeNodeFields(
  node: SceneTreeElement,
  style: LayoutStyle,
  rect: LayoutRect,
  text: TextMetricProvider,
  measuredLabel?: MeasuredLabel,
): SceneFields {
  const content =
    node.type === "video" || node.type === "audio"
      ? node.children.find((child) => child.kind === "element" && child.type === "contentNode")
      : undefined;
  const mediaFields: SceneFields =
    node.type === "video" || node.type === "audio"
      ? { content: content?.kind === "element" ? sceneNodeReference(content.handle) : null }
      : {};
  if (node.props.layout?.resource) return mediaFields;
  const fields: Record<string, SceneValue> = {
    ...mediaFields,
    translation: [rect.x, rect.y],
    visible: style.display !== "none",
  };
  if (typeof style.opacity === "number") fields.opacity = style.opacity;
  if (style.overflow === "hidden") fields.clippingRect = [0, 0, rect.width, rect.height];
  if (style.transform != null || style.transformOrigin != null)
    Object.assign(fields, sceneTransform(style.transform ?? [], rect, style.transformOrigin));
  if (["rectangle", "poster", "label", "multiStyleLabel", "video"].includes(node.type)) {
    if (rect.width <= 0 || rect.height <= 0) fields.visible = false;
    fields.width = rect.width;
    fields.height = rect.height;
  }
  const effect = node.children.find((child) => child.kind === "element" && child.type === "effect");
  if (effect?.kind === "element") fields.effect = sceneNodeReference(effect.handle);
  if (node.type === "label") {
    if (style.letterSpacing != null && style.letterSpacing !== 0)
      throw new RokuHostError("C04_LETTER_SPACING", "Letter spacing requires a glyph-run renderer");
    const metrics = text.metrics(style);
    const value =
      measuredLabel &&
      Object.is(measuredLabel.width, rect.width) &&
      Object.is(measuredLabel.lineHeight, metrics.lineHeight)
        ? measuredLabel.layout
        : layoutText(
            labelText(node),
            style,
            metrics,
            rect.width,
            Number(node.props.layout?.numberOfLines ?? 0),
          );
    fields.text = value.text;
    fields.color = rokuColor(style.color ?? "white");
    fields.horizAlign =
      typeof style.textAlign === "string" && style.textAlign !== "auto" ? style.textAlign : "left";
    fields.vertAlign = "top";
    fields.wrap = true;
    fields.numLines = value.lines.length;
    fields.lineSpacing = 0;
    if (typeof style.lineHeight === "number") {
      fields.lineSpacing = style.lineHeight - metrics.lineHeight;
      // Yoga owns the authored line box. Keep glyphs visible when Roku's
      // native font line box extends beyond that height.
      fields.displayPartialLines = true;
    }
    const font = text.font?.(style);
    if (font) fields.font = font;
  }
  if (node.type === "multiStyleLabel") {
    const runs = inlineTextRuns(node),
      styles: Record<string, unknown> = {};
    const escape = (value: string) =>
      value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    fields.text = runs
      .map((run, index) => {
        const uri = text.fontAsset?.(run.style);
        if (!uri)
          throw new RokuHostError(
            "C04_INLINE_FONT",
            "Mixed text requires the exact packaged font URI",
          );
        styles[`s${index}`] = {
          fontUri: uri,
          fontSize: Number(run.style.fontSize ?? 14),
          color: rokuColor(run.style.color ?? "white"),
        };
        return `<s${index}>${escape(run.text)}</s${index}>`;
      })
      .join("");
    fields.drawingStyles = styles;
    fields.wrap = false;
    fields.numLines = 1;
    fields.maxLines = 1;
    fields.ellipsisText = "…";
    fields.horizAlign = String(style.textAlign ?? "left");
    fields.vertAlign = "top";
  }
  if (node.type === "inlineText" && (rect.width <= 0 || rect.height <= 0)) fields.visible = false;
  return fields;
}

/** A paragraph is a measured group of one-line native styled labels. Keeping
 * each line independent preserves authored line heights without inventing a
 * MultiStyleLabel lineSpacing field. Nested React Text nodes stay virtual. */
export function nativeInlineTextLines(
  node: SceneTreeElement,
  style: LayoutStyle,
  rect: LayoutRect,
  text: TextMetricProvider,
): readonly SceneFields[] {
  if (rect.width <= 0 || rect.height <= 0) return [];
  const runs = inlineTextRuns(node);
  const layout = layoutInlineParagraph(
    runs,
    text,
    rect.width,
    Number(node.props.layout?.numberOfLines ?? 0),
  );
  const keys = new Map<LayoutStyle, string>();
  const drawingStyles: Record<string, SceneValue> = {};
  for (const run of runs) {
    if (keys.has(run.style)) continue;
    const key = `s${keys.size}`,
      uri = text.fontAsset?.(run.style);
    if (!uri)
      throw new RokuHostError("C04_INLINE_FONT", "Mixed text requires the exact packaged font URI");
    keys.set(run.style, key);
    drawingStyles[key] = {
      fontUri: uri,
      fontSize: Number(run.style.fontSize ?? 14),
      color: rokuColor(run.style.color ?? "white"),
    };
  }
  const escape = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return layout.lines.map((line) => ({
    translation: [0, line.y],
    width: rect.width,
    height: line.paintHeight,
    text: line.runs
      .map((run) => {
        const key = keys.get(run.style)!;
        return `<${key}>${escape(run.text)}</${key}>`;
      })
      .join(""),
    drawingStyles,
    wrap: false,
    numLines: 1,
    maxLines: 1,
    ellipsisText: "…",
    horizAlign: String(style.textAlign === "auto" ? "left" : (style.textAlign ?? "left")),
    vertAlign: "top",
  }));
}
