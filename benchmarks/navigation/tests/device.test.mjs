import assert from "node:assert/strict";
import test from "node:test";
import { coldLaunch } from "../cold.mjs";
import { catalogTitle, title } from "../../shelf/shared/shelf.ts";
import { holdRight } from "../held.mjs";
import { state } from "../holdout/replay.mjs";
import { routes, reveal } from "../holdout/model.ts";

test("one down and one up with no repeated keypress commands", async () => {
  const events = [];
  await holdRight(
    async (x) => events.push(x),
    550,
    async (ms) => events.push(ms),
  );
  assert.deepEqual(events, ["keydown", 550, "keyup"]);
});

test("release is attempted even when keydown acknowledgement is lost", async () => {
  const events = [];
  await assert.rejects(
    holdRight(async (action) => {
      events.push(action);
      if (action === "keydown") throw Error("lost ACK");
    }, 550),
    /lost ACK/,
  );
  assert.deepEqual(events, ["keydown", "keyup"]);
});

test("injected held presses repeat within one down/up sequence", async () => {
  const events = [];
  await holdRight(
    async (action) => events.push(action),
    550,
    async (ms) => events.push(ms),
    2,
  );
  assert.deepEqual(events, ["keydown", 183, "keydown", 184, "keydown", 183, "keyup"]);
});

test("holdout checks native visibility, focused identity, poster ownership and title width", () => {
  const xml =
    '<topscreen><plugin id="dev"/><group name="holdout-window" translation="{0, 10}"><group translation="{0, -192}"><group name="route-8" translation="{0, 384}" focused="true" focusable="true"><poster uri="pkg:/cover.png"/></group><group name="route-9"/></group></group><label name="holdout-title" bounds="{0, 0, 320, 92}" text="Long&#10;title"/></topscreen>';
  const s = state(xml);
  assert.ok(s.developer);
  assert.deepEqual(s.focus, ["route-8"]);
  assert.deepEqual(s.cards[0], { id: "route-8", y: 202, image: true });
  assert.equal(s.cards[1].image, false);
  assert.equal(s.clipY, 10);
  assert.deepEqual(s.title, { width: 320, height: 92, text: "Long title" });
});

test("holdout scroll restores the same slot after removal with distinct route IDs", () => {
  const origin = routes[7],
    successor = routes[8];
  let offset = 0;
  for (let i = 1; i <= 7; i++) offset = reveal(i, offset);
  const remaining = routes.filter((r) => r.id !== origin.id);
  assert.equal(reveal(remaining.indexOf(successor), offset), offset);
  assert.equal(successor.id, "route-9");
  assert.equal(new Set(remaining.map((r) => r.id)).size, 47);
});

test("cold launch verifies inactivity after lost acknowledgement and observes the first direction", async () => {
  let card = 0;
  const actions = [];
  const client = {
    terminate: async () => {
      actions.push("terminate");
      throw Error("No response after channel exit");
    },
    launch: async () => {
      actions.push("launch");
    },
    keypress: async (key) => {
      actions.push(key);
      card = 1;
    },
    query: async (name) => {
      if (name === "app-state/dev") {
        actions.push("verified inactive");
        return "<app-state><state>inactive</state></app-state>";
      }
      if (name === "active-app") {
        actions.push("left foreground");
        return '<active-app><app id="home">Home</app></active-app>';
      }
      const text = process.env.ROKU_SHELF_WORKLOAD === "catalog" ? catalogTitle(card) : title(card);
      return (
        '<topscreen><plugin id="dev"/><label name="selection" text="' +
        text +
        '"/><group focused="true" focusable="true" name="shelf-' +
        card +
        '"/></topscreen>'
      );
    },
  };
  const captures = [];
  const result = await coldLaunch(client, (name) => captures.push(name));
  assert.deepEqual(actions, [
    "terminate",
    "verified inactive",
    "left foreground",
    "launch",
    "Right",
  ]);
  assert.deepEqual(captures, ["lifecycle", 0, 1, "polls"]);
  assert.ok(result.responsiveTreeMs >= result.initialTreeMs);
});

test("public catalog cold launch waits for the enabled card after the first Right", async () => {
  const initial =
    '<group focused="true" focusable="true" name="catalog-card-0"/><Label name="catalog-position" text="1 of 72"/>';
  const stale =
    '<group focused="true" focusable="true" name="catalog-card-2"/><Label name="catalog-position" text="1 of 72"/>';
  const correct =
    '<group focused="true" focusable="true" name="catalog-card-2"/><Label name="catalog-position" text="3 of 72"/>';
  const apps = [initial, stale, correct];
  const actions = [];
  const client = {
    terminate: async () => actions.push("terminate"),
    launch: async () => actions.push("launch"),
    keypress: async (key) => actions.push(key),
    query: async (name) => {
      if (name === "app-state/dev") return "<app-state><state>inactive</state></app-state>";
      if (name === "active-app") return '<active-app><app id="home">Home</app></active-app>';
      return "<topscreen>" + apps.shift() + "</topscreen>";
    },
  };
  const captures = [];
  const result = await coldLaunch(
    client,
    (name) => captures.push(name),
    async () => {},
    true,
  );
  assert.deepEqual(actions, ["terminate", "launch", "Right"]);
  assert.deepEqual(captures, ["lifecycle", 0, 2, "polls"]);
  assert.deepEqual(
    result.samples.map(({ match }) => match),
    [true, false, true],
  );
});

import { installed, lease } from "../lab.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("installer receipt binds both checksum and byte count", () => {
  const want = { md5: "a".repeat(32), bytes: Buffer.alloc(1234) };
  const receipt = "Currently Installed Application: " + want.md5 + " zip file (1,234 bytes)";
  assert.equal(installed(receipt, want), true);
  assert.equal(installed(receipt.replace("1,234", "4,321"), want), false);
  assert.equal(installed(receipt.replace(want.md5, "b".repeat(32)), want), false);
  assert.equal(installed("Files: " + "a".repeat(32) + " " + "b".repeat(32) + " 1234", want), false);
});

test("independent lab clients contend for the same physical device", () => {
  const temp = mkdtempSync(join(tmpdir(), "roku-lease-"));
  try {
    const release = lease(temp, "DEVICE1234");
    assert.throws(() => lease(temp, "device1234"), { code: "EEXIST" });
    release();
    lease(temp, "device1234")();
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("settings persists the opposite value through exit and restores the original preference", async () => {
  const { verifySavedLayout } = await import("../../consumers/settings-storage.mjs");
  async function replay(initial, durable, correctFocus) {
    let saved = initial,
      value = saved,
      focus = "settings-edit",
      launches = 0;
    const client = {
      keypress: async (key) => {
        if (key === "Down") focus = correctFocus ? "settings-layout" : "settings-edit";
        else {
          assert.equal(key, "Select");
          value = value === "Compact" ? "Comfortable" : "Compact";
          if (durable) saved = value;
        }
      },
      terminate: async () => {},
      query: async (k) =>
        k === "active-app"
          ? "<active-app><app>Roku</app></active-app>"
          : "<app-state><state>inactive</state></app-state>",
      launch: async () => {
        launches++;
        focus = "settings-edit";
        value = saved;
      },
    };
    async function expect(name, predicate) {
      const xml = `<topscreen><plugin id="dev"/><group name="${focus}" focused="true"/><label name="settings-layout-value" text="${value}"/></topscreen>`;
      assert.ok(predicate(xml), name);
      return xml;
    }
    await verifySavedLayout(client, expect, () => {});
    assert.equal(launches, 2);
    assert.equal(saved, initial);
  }
  for (const initial of ["Compact", "Comfortable"]) await replay(initial, true, true);
  await assert.rejects(replay("Comfortable", false, true), /change-after-cold-launch/);
  await assert.rejects(replay("Compact", true, false), /change-focused/);
});
