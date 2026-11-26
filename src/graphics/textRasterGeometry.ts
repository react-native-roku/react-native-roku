import { RokuHostError } from "../scene/sceneGraph.types";
import { rokuColor } from "../react-native/styleSheet";
import type { TextRasterRequest, TextRasterSpec, TextDrawCommand } from "./textRaster.types";
export function textRasterSpec(request: TextRasterRequest): TextRasterSpec {
  const { style, layout, metrics } = request,
    spacing = Number(style.letterSpacing ?? 0),
    size = Number(style.fontSize ?? 14);
  const shadow = style.textShadowOffset as { width?: number; height?: number } | undefined;
  const radius = Number(style.textShadowRadius ?? 0),
    sx = Number(shadow?.width ?? 0),
    sy = Number(shadow?.height ?? 0);
  if (
    ![spacing, size, radius, sx, sy, request.width, request.height].every(Number.isFinite) ||
    size <= 0 ||
    radius < 0 ||
    request.width < 0 ||
    request.height < 0
  )
    throw new RokuHostError(
      "C04_RASTER_GEOMETRY",
      "Text raster geometry must be finite and nonnegative",
    );
  if (radius > 32)
    throw new RokuHostError(
      "C04_TEXT_SHADOW",
      "Text shadow radii above 32px exceed the beta raster budget",
    );
  const inset = Math.ceil(radius * 1.5 + Math.max(Math.abs(sx), Math.abs(sy)) + 2);
  const logicalWidth = Math.max(1, Math.ceil(request.width) + inset * 2),
    logicalHeight = Math.max(1, Math.ceil(request.height) + inset * 2);
  if (logicalWidth > 2048 || logicalHeight > 2048)
    throw new RokuHostError(
      "C04_RASTER_SIZE",
      "A text raster exceeds the native 2048px bitmap limit",
    );
  const maximumScale = 2048 / Math.max(logicalWidth, logicalHeight);
  const fontSize = Math.max(
    1,
    Math.min(512, Math.floor(size * maximumScale), Math.round(size * Math.min(2, maximumScale))),
  );
  // The native bitmap font is integral. A fractional bitmap scale preserves
  // the exact authored logical font size without rounding the product style.
  const scale = fontSize / size;
  if (scale > maximumScale)
    throw new RokuHostError(
      "C04_RASTER_FONT_SIZE",
      "The native font cannot fit this bitmap budget",
    );
  const lineHeight = Number(style.lineHeight ?? metrics.lineHeight),
    commands: TextDrawCommand[] = [];
  for (const [index, line] of layout.lines.entries()) {
    const width = metrics.width(line) + Math.max(0, Array.from(line).length - 1) * spacing;
    const align = style.textAlign ?? "left";
    if (!["left", "auto", "center", "right"].includes(String(align)))
      throw new RokuHostError("C04_TEXT_ALIGN", "Justified text needs a shaping adapter");
    const x =
        inset +
        (align === "center"
          ? (request.width - width) / 2
          : align === "right"
            ? request.width - width
            : 0),
      y = inset + index * lineHeight;
    if (!spacing) {
      commands.push({ text: line, x: x * scale, y: y * scale });
      continue;
    }
    // Whole runs retain native shaping. Tracked runs currently admit Latin and
    // punctuation and independent rating stars; complex shaping must never
    // become isolated codepoints.
    const unsupported = Array.from(line).find((char) => {
      const point = char.codePointAt(0)!;
      return (
        point > 0x024f &&
        !(point >= 0x2000 && point <= 0x206f) &&
        point !== 0x2605 &&
        point !== 0x2606
      );
    });
    if (unsupported)
      throw new RokuHostError(
        "C04_TRACKED_SCRIPT",
        `Tracked U+${unsupported.codePointAt(0)!.toString(16).toUpperCase()} requires grapheme and script shaping`,
      );
    const points = Array.from(line);
    if (points.some((char) => metrics.width(char) + spacing < 0))
      throw new RokuHostError("C04_LETTER_SPACING", "Tracking cannot reverse a glyph advance");
    points.forEach((char, position) =>
      commands.push({
        text: char,
        x:
          (x +
            metrics.width(points.slice(0, position + 1).join("")) -
            metrics.width(char) +
            position * spacing) *
          scale,
        y: y * scale,
      }),
    );
  }
  return {
    width: Math.ceil(logicalWidth * scale),
    height: Math.ceil(logicalHeight * scale),
    inset,
    scale,
    fontFamily: String(style.fontFamily ?? "RokuDefault"),
    fontSize,
    lineHeight: metrics.lineHeight * scale,
    commands,
    color: rokuColor(style.color ?? "white"),
    shadowColor: rokuColor(style.textShadowColor ?? "transparent"),
    shadowX: sx * scale,
    shadowY: sy * scale,
    shadowRadius: radius * scale,
  };
}
