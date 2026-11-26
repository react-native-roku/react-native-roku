import { RokuHostError } from "../scene/sceneGraph.types";
/** Separable Gaussian convolution of the complete text mask, preserving overlap. */
export function gaussianAlpha(
  source: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Float32Array {
  if (
    source.length !== width * height ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    !Number.isFinite(radius) ||
    radius < 0 ||
    radius > 64
  )
    throw new RokuHostError("C04_RASTER_PIXELS", "Invalid alpha raster or blur radius");
  if (!radius) return Float32Array.from(source, (value) => value / 255);
  const sigma = radius / 2,
    reach = Math.ceil(sigma * 3),
    kernel = Array.from({ length: reach * 2 + 1 }, (_, index) =>
      Math.exp(-((index - reach) ** 2) / (2 * sigma * sigma)),
    ),
    sum = kernel.reduce((a, b) => a + b, 0);
  const horizontal = new Float32Array(source.length),
    result = new Float32Array(source.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let value = 0;
      for (let k = -reach; k <= reach; k++)
        if (x + k >= 0 && x + k < width) value += source[y * width + x + k] * kernel[k + reach];
      horizontal[y * width + x] = value / (sum * 255);
    }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let value = 0;
      for (let k = -reach; k <= reach; k++)
        if (y + k >= 0 && y + k < height)
          value += horizontal[(y + k) * width + x] * kernel[k + reach];
      result[y * width + x] = value / sum;
    }
  return result;
}
const rgba = (color: string) => {
  const value = Number(color);
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, (value & 255) / 255];
};
/** Source-over composition in straight RGBA, with subpixel shadow translation. */
export function paintTextMask(
  mask: Uint8Array,
  width: number,
  height: number,
  color: string,
  shadowColor: string,
  radius: number,
  offsetX: number,
  offsetY: number,
): Uint8Array {
  const ink = rgba(color),
    shadow = rgba(shadowColor),
    blurred = gaussianAlpha(mask, width, height, shadow[3] ? radius : 0),
    result = new Uint8Array(mask.length * 4);
  const sample = (x: number, y: number) =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : blurred[y * width + x];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const px = x - offsetX,
        py = y - offsetY,
        ix = Math.floor(px),
        iy = Math.floor(py),
        fx = px - ix,
        fy = py - iy;
      const back =
        ((sample(ix, iy) * (1 - fx) + sample(ix + 1, iy) * fx) * (1 - fy) +
          (sample(ix, iy + 1) * (1 - fx) + sample(ix + 1, iy + 1) * fx) * fy) *
        shadow[3];
      const front = (mask[y * width + x] / 255) * ink[3],
        alpha = front + back * (1 - front),
        index = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++)
        result[index + channel] = alpha
          ? Math.round((ink[channel] * front + shadow[channel] * back * (1 - front)) / alpha)
          : 0;
      result[index + 3] = Math.round(alpha * 255);
    }
  return result;
}
