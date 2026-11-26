import assert from "node:assert/strict";
import {
  cardColor,
  catalogTitle,
  focusColor,
  next,
  tiles,
  title,
  titleFrame,
} from "./shared/shelf.ts";

const catalog = process.env.ROKU_SHELF_WORKLOAD === "catalog";
const keys = [
  "Right",
  "Right",
  "Down",
  "Right",
  "Down",
  "Left",
  "Left",
  "Up",
  "Up",
  "Left",
  "Down",
  "Down",
  "Right",
  "Right",
  "Right",
  "Up",
  "Up",
  "Left",
  "Left",
  "Left",
  "Right",
  "Down",
  "Right",
  "Down",
  "Right",
  "Left",
  "Up",
  "Left",
  "Up",
  "Left",
];
export function route(directions) {
  let from = 0;
  return directions.map((key) => {
    const to = next(from, key.toLowerCase());
    assert.notEqual(from, to, "Each scored input must request a different card");
    const step = { key, from, to };
    from = to;
    return step;
  });
}
export const warmup = route(["Right", "Left"]);
export const schedule = route(keys);

const attr = (tag, name) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag)?.[1];
const pressSuffix = / \| Press (shelf-\d+) #(\d+)$/;
const selectionLabel = (tag) => /^<label\b/i.test(tag) && attr(tag, "name") === "selection";
function sceneTags(xml) {
  const top = /<topscreen(?:\s[^>]*)?>([\s\S]*?)<\/topscreen>/.exec(xml)?.[1] ?? "";
  return Array.from(top.matchAll(/<[A-Za-z][\w.-]*(?:\s+[^<>]*?)?\s*\/?>/g), ([tag]) => tag);
}
export function shelfState(xml) {
  const tags = sceneTags(xml);
  const developers = tags.filter((tag) => /^<plugin\b/.test(tag) && attr(tag, "id") === "dev");
  const labels = tags.filter(selectionLabel);
  return {
    developer: developers.length === 1 && tags.filter((tag) => /^<plugin\b/.test(tag)).length === 1,
    titles: labels.map((tag) => attr(tag, "text")?.replace(pressSuffix, "") ?? null),
    focused: tags
      .filter(
        (tag) =>
          attr(tag, "focused") === "true" &&
          attr(tag, "focusable") === "true" &&
          /^shelf-\d+$/.test(attr(tag, "name") ?? ""),
      )
      .map((tag) => attr(tag, "name")),
  };
}
export function catalogState(xml) {
  const tags = sceneTags(xml);
  const detail = tags.find((tag) => attr(tag, "name") === "details");
  const back = tags.find((tag) => attr(tag, "name") === "back-to-catalog");
  const window = tags.findIndex((tag) => attr(tag, "name") === "catalog-window");
  // Solid translates its named content group directly. ScrollView supplies
  // an outer generated content group immediately inside the clip window.
  const content = window < 0 ? undefined : tags[window + 1];
  const translation = content && (attr(content, "translation") ?? "{0, 0}");
  return {
    detail: detail && attr(detail, "text"),
    backFocused: back && attr(back, "focused") === "true",
    offset: Number(/^{0, (-?\d+)}$/.exec(translation ?? "")?.[1]) * -1,
  };
}

export function shelfPress(xml) {
  const labels = sceneTags(xml).filter(selectionLabel);
  const match = labels.length === 1 && pressSuffix.exec(attr(labels[0], "text") ?? "");
  return match ? { id: match[1], count: Number(match[2]) } : null;
}
const normalizedCatalogTitle = (label) => label?.replace(/(?:&#xA;|&#10;|\s)+/gi, " ");
function hasSelection(state, index, label) {
  return (
    state.developer &&
    state.titles.length === 1 &&
    label &&
    state.focused.length === 1 &&
    state.focused[0] === tiles[index].id
  );
}
export function isSelection(state, index) {
  return hasSelection(
    state,
    index,
    catalog
      ? normalizedCatalogTitle(state.titles[0]) === catalogTitle(index)
      : state.titles[0] === title(index),
  );
}

export function isCatalogSettled(xml, index, offset) {
  const state = shelfState(xml);
  if (!hasSelection(state, index, normalizedCatalogTitle(state.titles[0]) === catalogTitle(index)))
    return false;
  const scene = catalogState(xml);
  if (scene.detail || scene.offset !== offset) return false;
  const tags = sceneTags(xml);
  const label = tags.find(selectionLabel);
  const bounds = /^\{-?\d+, -?\d+, (\d+), (\d+)\}$/.exec(attr(label, "bounds") ?? "");
  if (
    !bounds ||
    Number(bounds[1]) !== titleFrame.width ||
    Number(bounds[2]) !== (index % 3 ? 117 : 39)
  )
    return false;
  if (attr(label, "isTextEllipsized") === "true") return false;
  const paint = new Map();
  for (const [i, node] of tags.entries()) {
    const id = attr(node, "name");
    if (id && /^shelf-\d+$/.test(id) && !node.endsWith("/>") && tags[i + 1])
      paint.set(id, attr(tags[i + 1], "color")?.toLowerCase());
  }
  return tiles.every(
    (tile) =>
      paint.get(tile.id) === (tile.index === index ? focusColor : cardColor).toLowerCase() + "ff",
  );
}

export function statistics(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = (sorted.length - 1) / 2;
  return {
    count: sorted.length,
    medianMs: (sorted[Math.floor(middle)] + sorted[Math.ceil(middle)]) / 2,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    worstMs: sorted.at(-1),
  };
}

export function score(samples) {
  const results = schedule.map((step, index) => {
    const sample = samples[index];
    const ack = sample?.ackMs;
    const first = sample?.polls.find(
      (p) =>
        p.startMs >= ack &&
        p.endMs >= p.startMs &&
        p.endMs <= sample.deadlineMs &&
        isSelection(shelfState(p.xml ?? ""), step.to),
    );
    const input = sample?.key === step.key && sample.from === step.from && sample.to === step.to;
    const before = Boolean(
      sample?.before?.xml && isSelection(shelfState(sample.before.xml), step.from),
    );
    return {
      ...step,
      ackMs: ack ?? null,
      observedMs: first?.endMs ?? null,
      pass: input && before && Number.isFinite(ack) && ack >= 0 && Boolean(first) && !sample.error,
    };
  });
  const successful = results.filter((result) => result.pass);
  return {
    pass: samples.length === schedule.length && successful.length === schedule.length,
    failedInputs: results.filter((result, i) => i < samples.length && !result.pass).length,
    unattemptedInputs: Math.max(0, schedule.length - samples.length),
    acknowledgement: statistics(results.flatMap(({ ackMs }) => (ackMs == null ? [] : [ackMs]))),
    observed: statistics(successful.map(({ observedMs }) => observedMs)),
    results,
  };
}
