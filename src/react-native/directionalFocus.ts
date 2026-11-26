import type { LayoutRect } from "../layout/flexLayout";

type Direction = "up" | "right" | "down" | "left";
const measurable = (rect: LayoutRect) =>
  [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
  rect.width > 0 &&
  rect.height > 0;

/** Mechanical fallback for an unbound direction. Explicit topology stays with
 * the caller. Prefer the directional beam, then axis-weighted distance; equal
 * candidates retain committed tree order. Coordinates include transforms. */
export function directionalFocusTarget(
  origin: LayoutRect,
  direction: Direction,
  candidates: Iterable<readonly [string, { readonly global: LayoutRect }]>,
  eligible: (id: string) => boolean,
): string | undefined {
  if (!measurable(origin)) return;
  const horizontal = direction === "left" || direction === "right";
  const forward = direction === "right" || direction === "down";
  const axes = (rect: LayoutRect) => {
    const start = horizontal ? rect.x : rect.y;
    const size = horizontal ? rect.width : rect.height;
    return {
      start: forward ? start : -start - size,
      end: forward ? start + size : -start,
      cross: horizontal ? rect.y : rect.x,
      crossSize: horizontal ? rect.height : rect.width,
    };
  };
  const source = axes(origin);
  let selected: string | undefined;
  let bestBeam = false,
    bestScore = Infinity;
  for (const [id, placement] of candidates) {
    if (!eligible(id)) continue;
    const rect = placement.global;
    if (!measurable(rect)) continue;
    const target = axes(rect);
    if (!((source.start < target.start || source.end <= target.start) && source.end < target.end))
      continue;
    const beam =
      target.cross < source.cross + source.crossSize &&
      target.cross + target.crossSize > source.cross;
    const major = Math.max(0, target.start - source.end);
    const minor = target.cross + target.crossSize / 2 - source.cross - source.crossSize / 2;
    const score = 13 * major * major + minor * minor;
    if (selected === undefined || (beam && !bestBeam) || (beam === bestBeam && score < bestScore)) {
      selected = id;
      bestBeam = beam;
      bestScore = score;
    }
  }
  return selected;
}
