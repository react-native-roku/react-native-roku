export const rowHeight = 96;
export const windowHeight = 3 * rowHeight;
export const wide = 720;
export const narrow = 320;

export const routes = Array.from({ length: 48 }, (_, i) => ({
  id: "route-" + (i + 1),
  title:
    i % 3 === 1
      ? "Route " + (i + 1) + " — Long ridge walk past the lakes and back to the valley"
      : "Route " + (i + 1) + " — Valley walk",
}));
export type Route = (typeof routes)[number];

export function reveal(index: number, offset: number) {
  const top = index * rowHeight;
  return Math.max(0, Math.min(top, Math.max(offset, top + rowHeight - windowHeight)));
}
