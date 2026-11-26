import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { buildRokuReactModules } from "./frontend.mjs";
test("small applications need one build and no partition entries", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "rnr-small-frontend-"));
  try {
    writeFileSync(resolve(root, "entry.mjs"), "export const value=42;");
    let builds = 0;
    const result = await buildRokuReactModules({
      absWorkingDir: root,
      entryPoints: ["entry.mjs"],
      outfile: "output.mjs",
      bundle: true,
      format: "esm",
      plugins: [
        {
          name: "count-builds",
          setup(builder) {
            builder.onStart(() => {
              builds++;
            });
          },
        },
      ],
    });
    assert.equal(builds, 1);
    assert.deepEqual(Object.keys(result.metafile.outputs), ["output.mjs"]);
    assert.equal((await import(pathToFileURL(resolve(root, "output.mjs")))).value, 42);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("partition retries retain shared state and only the final emitted graph", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "rnr-partition-retries-"));
  try {
    writeFileSync(
      resolve(root, "shared.mjs"),
      `let count=0;export function next(){return ++count;}export const unused=${JSON.stringify("u".repeat(2000))};`,
    );
    for (let n = 0; n < 150; n++)
      writeFileSync(
        resolve(root, `module-${n}.mjs`),
        `import {next} from './shared.mjs';export const data=${JSON.stringify("x".repeat(4096))};export const read=next;`,
      );
    writeFileSync(
      resolve(root, "entry.mjs"),
      Array.from({ length: 150 }, (_, n) => `import * as m${n} from './module-${n}.mjs';`).join(
        "\n",
      ) +
        `\nexport const result=[${Array.from({ length: 150 }, (_, n) => `[m${n}.read(),m${n}.data.length]`).join(",")}];`,
    );
    const result = await buildRokuReactModules(
      {
        absWorkingDir: root,
        entryPoints: ["entry.mjs"],
        outfile: "dist/application.mjs",
        bundle: true,
        format: "esm",
      },
      { maxModuleBytes: 32 * 1024 },
    );
    assert.ok(Object.values(result.metafile.outputs).every((file) => file.bytes <= 32 * 1024));
    const walk = (directory) =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(resolve(directory, entry.name))
          : [resolve(directory, entry.name)],
      );
    assert.deepEqual(
      walk(resolve(root, "dist"))
        .map((path) => relative(root, path))
        .sort(),
      Object.keys(result.metafile.outputs)
        .map((path) => relative(root, resolve(root, path)))
        .sort(),
      "Abandoned partition outputs remain on disk",
    );
    assert.deepEqual(
      (await import(pathToFileURL(resolve(root, "dist/application.mjs")))).result,
      Array.from({ length: 150 }, (_, n) => [n + 1, 4096]),
    );
    writeFileSync(resolve(root, "retained.mjs"), "caller-owned-output");
    const buffered = await buildRokuReactModules(
      {
        absWorkingDir: root,
        entryPoints: ["entry.mjs"],
        outfile: "retained.mjs",
        bundle: true,
        format: "esm",
        write: false,
      },
      { maxModuleBytes: 32 * 1024 },
    );
    assert.ok(buffered.outputFiles.length > 1);
    assert.equal(readFileSync(resolve(root, "retained.mjs"), "utf8"), "caller-owned-output");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("bounded frontend preserves one shared module instance and the original application result", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "rnr-frontend-"));
  try {
    writeFileSync(resolve(root, "state.mjs"), "export const state={count:0};");
    for (const name of ["a", "b"])
      writeFileSync(
        resolve(root, name + ".mjs"),
        `import {state} from './state.mjs';export const data=${JSON.stringify(name.repeat(500))};export function update(){return ++state.count;}`,
      );
    writeFileSync(
      resolve(root, "entry.mjs"),
      "import * as a from './a.mjs';import * as b from './b.mjs';export const result=[a.update(),b.update(),a.data.length+b.data.length];",
    );
    const result = await buildRokuReactModules(
      {
        absWorkingDir: root,
        entryPoints: ["entry.mjs"],
        outfile: "dist/application.mjs",
        bundle: true,
        format: "esm",
        platform: "neutral",
      },
      { maxModuleBytes: 1024 },
    );
    assert.ok(Object.values(result.metafile.outputs).every((output) => output.bytes <= 1024));
    assert.deepEqual(
      (await import(pathToFileURL(resolve(root, "dist/application.mjs")))).result,
      [1, 2, 1000],
    );
    writeFileSync(
      resolve(root, "large.mjs"),
      `export const data=${JSON.stringify("x".repeat(3000))};`,
    );
    await assert.rejects(
      buildRokuReactModules(
        {
          absWorkingDir: root,
          entryPoints: ["large.mjs"],
          outfile: "other/application.js",
          bundle: true,
          format: "esm",
        },
        { maxModuleBytes: 1024 },
      ),
      /Review frontend partitioning/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
