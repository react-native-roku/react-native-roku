const attr = (tag, name) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag)?.[1];
export const cardID = (id) => /^catalog-card-\d+$/.test(id);
export function state(xml) {
  const screen = /<topscreen(?:\s[^>]*)?>([\s\S]*?)<\/topscreen>/.exec(xml)?.[1] ?? "";
  const nodes = [];
  const ancestors = [];
  for (const [tag] of screen.matchAll(/<\/?[A-Za-z][^<>]*>/g)) {
    if (tag.startsWith("</")) {
      ancestors.pop();
      continue;
    }
    const parent = ancestors.at(-1);
    const translation = attr(tag, "translation");
    const [x, y] = translation?.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [0, 0];
    const node = {
      name: attr(tag, "name"),
      bounds: attr(tag, "bounds"),
      translation,
      x: (parent?.x ?? 0) + x,
      y: (parent?.y ?? 0) + y,
      focused: attr(tag, "focused") === "true",
      focusable: attr(tag, "focusable") === "true",
      text: attr(tag, "text"),
    };
    nodes.push(node);
    if (!tag.endsWith("/>")) ancestors.push(node);
  }
  const focused = nodes.filter(
    (node) =>
      node.focused &&
      node.focusable &&
      /^(?:catalog-card-\d+|catalog-info|catalog-back|catalog-modal-close)$/.test(node.name ?? ""),
  );
  return {
    focused: focused.map((node) => ({
      name: node.name,
      bounds: node.bounds,
      translation: node.translation,
      x: node.x,
      y: node.y,
    })),
    observedNodes: nodes.length,
    mountedCards: nodes.filter((node) => cardID(node.name ?? "")).length,
    details: nodes.find((node) => node.name === "catalog-detail-title")?.text ?? null,
    modal: nodes.find((node) => node.name === "catalog-modal-title")?.text ?? null,
    position: nodes.find((node) => node.name === "catalog-position")?.text ?? null,
    gridY: nodes.find((node) => node.name === "catalog-grid")?.y ?? null,
  };
}
export const focused = (sample, id) => sample.focused.length === 1 && sample.focused[0].name === id;
