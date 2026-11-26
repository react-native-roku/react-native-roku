import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildRokuMetroModules } from "./frontend.mjs";

test("optional Metro builds explain missing tools before creating generated output", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "rnr-metro-missing-"));
  try {
    writeFileSync(resolve(root, "package.json"), "{}");
    await assert.rejects(
      buildRokuMetroModules({ root, entry: "App.tsx", outfile: "dist/app.mjs" }),
      /Install the optional Metro tool cohort/,
    );
    assert.deepEqual(readdirSync(root), ["package.json"]);
    await assert.rejects(
      buildRokuMetroModules({ root, entry: "App.tsx", outfile: "dist/app.mjs", profile: "typo" }),
      /profile production or development/,
    );
    await assert.rejects(buildRokuMetroModules({ root }), /entry and outfile/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
