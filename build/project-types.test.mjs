import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { packageRoot } from "./index.mjs";

test("public build declarations accept compilation profiles and reject unknown profiles", () => {
  const parent = resolve(packageRoot, ".local");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(resolve(parent, "project-profile-types-"));
  try {
    const source = resolve(directory, "consumer.ts");
    writeFileSync(
      source,
      readFileSync(resolve(packageRoot, "examples/minimal/src/buildProfiles.typecheck.ts")),
    );
    const config = resolve(directory, "tsconfig.json");
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          noEmit: true,
          strict: true,
          skipLibCheck: true,
          moduleResolution: "Bundler",
          module: "ESNext",
          target: "ES2022",
          types: ["node"],
        },
        files: [source, resolve(packageRoot, "examples/minimal/src/metro.typecheck.ts")],
      }),
    );
    const result = spawnSync(
      resolve(packageRoot, "node_modules/.bin/tsc"),
      ["--noEmit", "--project", config],
      { cwd: packageRoot, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
