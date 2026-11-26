import assert from "node:assert/strict";
import { test } from "node:test";
import {
  catalogState,
  isCatalogSettled,
  isSelection,
  schedule,
  score,
  shelfPress,
  shelfState,
} from "./score.mjs";
import { cardColor, catalogTitle, focusColor, tiles, title } from "./shared/shelf.ts";

const tree = (label, focus, plugin = "dev") =>
  `<app-ui><topscreen><plugin id="${plugin}" /><screen focused="true">
  <KeyHandler name="shelf-keys" focusable="true" focused="true" />
  <Label text="${title(label)}" name="selection" />
  ${focus.map((index) => `<Group name="shelf-${index}" focusable="true" focused="true" />`).join("")}
  </screen></topscreen></app-ui>`;

test("scores each step only with a fresh matching title and native card focus before the deadline", () => {
  const now = 10;
  const clean = schedule.map(({ key, from, to }) => ({
    key,
    from,
    to,
    before: { xml: tree(from, [from]) },
    ackMs: 4,
    deadlineMs: 100,
    polls: [{ startMs: 5, endMs: now, xml: tree(to, [to]) }],
  }));
  assert.equal(score(clean).pass, true);
  const { from, to } = schedule[0];
  for (const xml of [
    tree(from, [to]),
    tree(to, []),
    tree(to, [from]),
    tree(to, [to, from]),
    tree(from, [from]),
    tree(to, [to], "some-other-channel"),
  ]) {
    assert.equal(isSelection(shelfState(xml), to), false);
    const failed = score([
      { ...clean[0], polls: [{ startMs: 5, endMs: now, xml }] },
      ...clean.slice(1),
    ]);
    assert.equal(failed.pass, false);
    assert.equal(failed.failedInputs, 1);
  }
  const late = score([{ ...clean[0], polls: [{ startMs: 5, endMs: 101, xml: tree(to, [to]) }] }]);
  assert.equal(late.failedInputs, 1);
  assert.equal(late.unattemptedInputs, 29);
  assert.equal(score([{ ...clean[0], ackMs: undefined }]).failedInputs, 1);
  assert.equal(score([{ ...clean[0], key: "Left" }, ...clean.slice(1)]).pass, false);
  assert.equal(score([...clean, clean[0]]).pass, false);
});

test("reads activation independently of title and focus", () => {
  const xml = tree(2, [2]);
  assert.equal(shelfPress(xml), null);
  const pressed = xml.replace(`text="${title(2)}"`, `text="${title(2)} | Press shelf-2 #4"`);
  assert.equal(isSelection(shelfState(pressed), 2), true);
  assert.deepEqual(shelfPress(pressed), { id: "shelf-2", count: 4 });
  assert.equal(
    shelfPress(pressed.replace("</screen>", '<Label name="selection" /></screen>')),
    null,
  );
});

test("reads native catalog scroll and detail focus from both consumer shapes", () => {
  for (const content of ["catalog-content", "_roku-r_4_"]) {
    const xml = `<app-ui><topscreen><plugin id="dev" /><screen>
      <Group name="catalog-window"><Group name="${content}" translation="{0, -104}" /></Group>
      <Label text="Details for Selected Card 18" name="details" />
      <Group name="back-to-catalog" focused="true" />
      </screen></topscreen></app-ui>`;
    assert.deepEqual(catalogState(xml), {
      detail: "Details for Selected Card 18",
      backFocused: true,
      offset: 104,
    });
  }
});

test("requires the restored catalog to settle its highlight as well as title and focus", () => {
  const selected = 11;
  const catalog = `<topscreen><plugin id="dev"/><screen>
    <Label name="selection" text="${catalogTitle(selected)}" bounds="{0, 0, 1050, 117}" />
    <Group name="catalog-window"><Group translation="{0, -104}">
    ${tiles
      .map(
        ({ id, index }) => `<Group name="${id}" focused="${index === selected}" focusable="true">
      <Rectangle color="${index === selected ? focusColor : cardColor}ff"/>
    </Group>`,
      )
      .join("")}
    </Group></Group></screen></topscreen>`;
  assert.equal(isCatalogSettled(catalog, selected, 104), true);
  assert.equal(isCatalogSettled(catalog.replace(focusColor, cardColor), selected, 104), false);
  assert.equal(isCatalogSettled(catalog.replace("1050, 117", "1050, 39"), selected, 104), false);
  assert.equal(isCatalogSettled(catalog, selected, 0), false);
});
