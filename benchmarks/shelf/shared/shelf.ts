export const rows = 3;
export const columns = 8;
export const viewport = { width: 1920, height: 1080 };
export const titleFrame = { left: 64, top: 44, width: 1050, height: 55 };
export const titleFontSize = 30;
export const cardFontSize = 20;
export const cardLabelHeight = 30;
export const cardWidth = 122;
export const cardHeight = 92;
export const cardColor = "#1C2A38";
export const focusColor = "#87CEFA";
export const titleColor = "#F0F3FA";
export const tiles = Array.from({ length: rows * columns }, (_, index) => ({
  index,
  id: "shelf-" + index,
  title: "Card " + (index + 1),
  x: 64 + (index % columns) * 135,
  y: 115 + Math.floor(index / columns) * 112,
}));
export const title = (index: number) => "Selected " + tiles[index].title;
export function next(index: number, key: string) {
  if (key === "up" && index >= columns) return index - columns;
  if (key === "down" && index < (rows - 1) * columns) return index + columns;
  if (key === "left" && index % columns !== 0) return index - 1;
  if (key === "right" && index % columns !== columns - 1) return index + 1;
  return index;
}

export const catalogTop = 180;
export const catalogLeft = 64;
export const catalogWidth = 1080;
export const catalogHeight = 212;
export const rowStep = 112;
export const contentHeight = 3 * rowStep;
export const catalogTitle = (index: number) =>
  index % 3 === 0
    ? title(index)
    : title(index) +
      " · " +
      "A feature-length selection with an extended catalog description. ".repeat(3).trim();
export const detailTitle = (index: number) => "Details for " + title(index);
export const cardTop = (index: number) => Math.floor(index / columns) * rowStep;
export const cardLeft = (index: number) => tiles[index].x - catalogLeft;
export function scrollFor(index: number, current: number) {
  const top = cardTop(index);
  return Math.max(
    0,
    Math.min(
      contentHeight - catalogHeight,
      Math.max(top + 92 - catalogHeight, Math.min(top, current)),
    ),
  );
}
