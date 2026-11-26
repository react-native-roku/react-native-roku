import type { InlineRasterRequest, TextRasterSpec } from "./textRaster.types";
import { textRasterSpec } from "./textRasterGeometry";
import { layoutText } from "../layout/textLayout";
import { RokuHostError } from "../scene/sceneGraph.types";

/** Fitting single-line spans use their own fonts on one common bitmap scale. */
export function inlineRasterSpecs(request: InlineRasterRequest): TextRasterSpec[] {
  if (!request.runs.length || request.runs.length > 64)
    throw new RokuHostError("C04_INLINE_RUNS", "Mixed text requires 1–64 runs");
  const runs = request.runs.map((run) => ({
    ...run,
    text: layoutText(run.text, run.style, run.metrics, Infinity, 1).text,
  }));
  const widths = runs.map((run) => layoutText(run.text, run.style, run.metrics, Infinity, 1).width);
  const total = widths.reduce(
    (sum, width, index) =>
      sum + width + (index < runs.length - 1 ? Number(runs[index].style.letterSpacing ?? 0) : 0),
    0,
  );
  if (Math.fround(total) > Math.fround(request.width))
    throw new RokuHostError("C04_INLINE_WRAP", "Mixed raster text must fit one line");
  const specs = runs.map((run) =>
    textRasterSpec({
      ...run,
      style: { ...run.style, textAlign: "left" },
      width: request.width,
      height: request.height,
      layout: {
        text: run.text,
        lines: [run.text],
        width: request.width,
        height: request.height,
      },
    }),
  );
  if (
    specs.some(
      (spec) =>
        spec.width !== specs[0].width ||
        spec.height !== specs[0].height ||
        spec.scale !== specs[0].scale ||
        spec.inset !== specs[0].inset ||
        Number(spec.shadowColor) & 255,
    )
  )
    throw new RokuHostError(
      "C04_INLINE_RASTER",
      "Mixed tracking requires a common bitmap scale and no shadow",
    );
  const align = runs[0].style.textAlign;
  let left =
    align === "center"
      ? (request.width - total) / 2
      : align === "right"
        ? request.width - total
        : 0;
  return specs.map((spec, index) => {
    const result = {
      ...spec,
      commands: spec.commands.map((command) => ({
        ...command,
        x: command.x + left * spec.scale,
      })),
    };
    left += widths[index] + Number(runs[index].style.letterSpacing ?? 0);
    return result;
  });
}

/** Source-over ink layers share one bitmap geometry and alpha convention. */
export function overlayRgba(target: Uint8Array, layer: Uint8Array) {
  if (target.length !== layer.length || target.length % 4)
    throw new RokuHostError("C04_RASTER_PIXELS", "Mismatched mixed-text layers");
  for (let index = 0; index < target.length; index += 4) {
    const front = layer[index + 3] / 255,
      back = target[index + 3] / 255;
    const alpha = front + back * (1 - front);
    if (!front) continue;
    for (let channel = 0; channel < 3; channel++)
      target[index + channel] = Math.round(
        (layer[index + channel] * front + target[index + channel] * back * (1 - front)) / alpha,
      );
    target[index + 3] = Math.round(alpha * 255);
  }
}
