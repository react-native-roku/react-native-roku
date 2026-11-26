import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cardColor,
  cardHeight,
  cardLabelHeight,
  cardWidth,
  focusColor,
  tiles,
  title,
  titleColor,
} from "./shared/shelf.ts";
import { isSelection, shelfState, statistics } from "./score.mjs";

const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`, "i").exec(tag)?.[1];
const rgba = (color) => color.toLowerCase() + "ff";
const bounds = (x, y, w, h) => `{${x}, ${y}, ${w}, ${h}}`;

const groupsIn = (xml) => [
  ...xml.matchAll(
    /(<[\w.-]+\s[^<>]*\bname="shelf-(\d+)"[^<>]*>)\s*(<Rectangle\b[^<>]*\/>)\s*(<Label\b[^<>]*\/>)/gi,
  ),
];

function check(xml, expectedIndex) {
  assert.ok(isSelection(shelfState(xml), expectedIndex));
  const groups = groupsIn(xml);
  assert.equal(groups.length, tiles.length);
  const seen = new Set();
  for (const [, group, indexText, rectangle, label] of groups) {
    const index = Number(indexText);
    const tile = tiles[index];
    assert.ok(tile && !seen.has(index));
    seen.add(index);
    assert.equal(attr(group, "bounds"), bounds(tile.x, tile.y, cardWidth, cardHeight));
    assert.equal(attr(rectangle, "bounds"), bounds(0, 0, cardWidth, cardHeight));
    assert.equal(
      attr(rectangle, "color")?.toLowerCase(),
      rgba(index === expectedIndex ? focusColor : cardColor),
    );
    assert.equal(attr(label, "bounds"), bounds(0, 0, cardWidth, cardLabelHeight));
    assert.equal(attr(label, "color")?.toLowerCase(), rgba(titleColor));
    assert.equal(attr(label, "text"), tile.title);
  }
}

const [directory] = process.argv.slice(2);
assert.ok(directory, "Usage: node scene.mjs RUN_DIRECTORY");
const file = (name) => JSON.parse(readFileSync(join(directory, name), "utf8"));
const summary = file("summary.json");
assert.ok(summary.pass && summary.cohort !== "cold", "A passed warm or traced replay is required");
const stages = [];
for (const [index, step] of summary.results.entries()) {
  const raw = file(`step-${String(index + 1).padStart(2, "0")}.json`);
  check(raw.before.xml, step.from);
  const observed = raw.polls.find(({ endMs }) => endMs === step.observedMs);
  assert.ok(observed, "Raw observation missing");
  check(observed.xml, step.to);
  const stateOf = ({ xml = "", ...reading }) => {
    const state = shelfState(xml);
    const highlights = groupsIn(xml)
      .filter(([, , , rect]) => attr(rect, "color")?.toLowerCase() === rgba(focusColor))
      .map((entry) => Number(entry[2]));
    return {
      ...reading,
      nativeFocus: state.focused.length === 1 && state.focused[0] === tiles[step.to].id,
      title: state.titles.length === 1 && state.titles[0] === title(step.to),
      highlight: highlights.length === 1 && highlights[0] === step.to,
    };
  };
  const readings = raw.polls.map(stateOf);
  const first = (predicate) => readings.find(predicate)?.endMs ?? null;
  stages.push({
    key: step.key,
    from: step.from,
    to: step.to,
    polls: readings,
    focusMs: first((p) => p.nativeFocus),
    titleMs: first((p) => p.title),
    highlightMs: first((p) => p.highlight),
    jointMs: first((p) => p.nativeFocus && p.title && p.highlight),
  });
}
const metrics = Object.fromEntries(
  ["focusMs", "titleMs", "highlightMs", "jointMs"].map((name) => [
    name,
    statistics(stages.map((stage) => stage[name]).filter(Number.isFinite)),
  ]),
);
console.log(JSON.stringify({ verified: stages.length, metrics, stages }, null, 2));
