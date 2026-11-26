import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { packageRoot, resolveAdapter } from "../index.mjs";

test("Node testing helpers satisfy real socket and decoder-retirement controls", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "roku-node-testing-")),
    program = resolve(directory, "proof.cjs");
  await build({
    entryPoints: [resolve(packageRoot, "examples/minimal/src/nodeTesting.mjs")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: program,
    alias: { "react-native": resolveAdapter("react-native") },
  });
  const proof = await createRequire(import.meta.url)(program).qualifyNodeTesting();
  assert.equal(proof.status, "passed");
});
