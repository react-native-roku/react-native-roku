import assert from "node:assert/strict";
import { test } from "node:test";
import { activationCard, burstKeys, focusOrder, scoreBurst } from "./burst.mjs";

test("requires the full ordered focus sequence and exactly one intended activation", () => {
  const edges = burstKeys.flatMap((key) => [key + ":down", key + ":up"]);
  const valid = { edges, nativeFocus: focusOrder, activation: [activationCard] };
  assert.ok(scoreBurst(valid).pass);
  assert.equal(
    scoreBurst({ ...valid, nativeFocus: ["shelf-1", "shelf-3", "shelf-2"] }).focusPassed,
    false,
  );
  assert.equal(
    scoreBurst({ ...valid, nativeFocus: ["shelf-1", "shelf-3", "shelf-2", "shelf-2"] }).focusPassed,
    false,
  );
  assert.equal(scoreBurst({ ...valid, activation: ["shelf-3"] }).activationPassed, false);
  assert.equal(
    scoreBurst({ ...valid, activation: [activationCard, activationCard] }).activationPassed,
    false,
  );
  assert.equal(scoreBurst({ ...valid, activation: [] }).activationPassed, false);
  assert.equal(scoreBurst({ ...valid, edges: edges.slice(0, -1) }).keysPassed, false);
});
