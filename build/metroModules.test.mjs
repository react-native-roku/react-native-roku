import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { GenMapping, addMapping, setSourceContent, toEncodedMap } from "@jridgewell/gen-mapping";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import { writeMetroModules } from "./metroModules.mjs";

function fixture() {
  return `var __DEV__=true,process={env:{NODE_ENV:'development'}};
(function(global){const modules=new Map();global.__d=(factory,id,deps)=>modules.set(id,{factory,deps,exports:{},loaded:false});global.__r=function read(id){const m=modules.get(id);if(!m.loaded){m.loaded=true;m.factory(global,n=>read(m.deps[n]),null,null,m,m.exports,m.deps)}return m.exports}})(globalThis);
__d(function(global,require,_a,_b,module,exports){const state=require(0);exports.value=()=>++state.count;exports.profile=()=>process.env.NODE_ENV;exports.data=${JSON.stringify("x".repeat(220))}},0,[1]);
__d(function(global,require,_a,_b,module,exports){exports.count=0;exports.peer=require(0);},1,[0]);
__r(0);
`;
}

test("Metro refuses unlowered module declarations before publishing any frontend files", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rnr-metro-unlowered-"));
  try {
    for (const statement of [
      'import {value} from "./dependency";',
      "export const value = 1;",
      'export default "data";',
    ]) {
      assert.throws(
        () =>
          writeMetroModules({
            code: fixture().replace(
              "const state=require(0);",
              statement + "const state=require(0);",
            ),
            outfile: resolve(root, "application.mjs"),
            exports: ["value"],
          }),
        /Metro.*serialization/,
      );
      assert.deepEqual(readdirSync(root), []);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit Metro profile remains local when the host has another NODE_ENV", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rnr-metro-profile-"));
  try {
    const file = resolve(root, "application.mjs");
    writeMetroModules({
      code: fixture().replace(
        "process={env:{NODE_ENV:'development'}}",
        "process=globalThis.process",
      ),
      outfile: file,
      exports: ["profile"],
      profile: "development",
    });
    const stdout = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const app=await import(${JSON.stringify(pathToFileURL(file).href)});console.log(JSON.stringify({app:app.profile(),host:process.env.NODE_ENV}));`,
      ],
      { encoding: "utf8", env: { ...process.env, NODE_ENV: "production" } },
    );
    assert.deepEqual(JSON.parse(stdout), { app: "development", host: "production" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounded Metro modules preserve circular imports, lazy shared state, profiles and public exports", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "rnr-metro-modules-"));
  try {
    writeFileSync(resolve(root, "keep.txt"), "caller owns this");
    const code = fixture();
    const result = writeMetroModules({
      code,
      outfile: resolve(root, "application.mjs"),
      exports: ["value", "profile", "data"],
      entryModuleId: 0,
      maxModuleBytes: 800,
    });
    assert.ok(result.modules > 1);
    for (const file of result.files.filter((file) => file.path.endsWith(".mjs")))
      assert.ok(file.bytes <= 800, file.path);
    const application = await import(pathToFileURL(resolve(root, "application.mjs")));
    assert.equal(application.value(), 1);
    assert.equal(application.value(), 2);
    assert.equal(application.profile(), "development");
    assert.equal(application.data.length, 220);
    assert.equal(readFileSync(resolve(root, "keep.txt"), "utf8"), "caller owns this");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Metro split source maps retain original source, line, column and source contents", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rnr-metro-map-"));
  try {
    const code = fixture();
    const source = "export const original = 42;";
    const map = new GenMapping();
    setSourceContent(map, "original.ts", source);
    addMapping(map, {
      generated: { line: 3, column: 0 },
      original: { line: 1, column: 7 },
      source: "original.ts",
      name: "original",
    });
    const result = writeMetroModules({
      code,
      map: toEncodedMap(map),
      outfile: resolve(root, "application.mjs"),
      exports: ["value"],
      entryModuleId: 0,
      maxModuleBytes: 800,
    });
    const file = result.files.find(
      (file) => file.path.includes("module-") && file.path.endsWith(".mjs"),
    );
    const emitted = readFileSync(file.path, "utf8"),
      index = emitted.indexOf("__d(function");
    const preceding = emitted.slice(0, index).split("\n");
    const output = new TraceMap(JSON.parse(readFileSync(file.path + ".map", "utf8")));
    const original = originalPositionFor(output, {
      line: preceding.length,
      column: preceding.at(-1).length,
    });
    assert.deepEqual(original, { source: "original.ts", line: 1, column: 7, name: "original" });
    assert.deepEqual(output.sourcesContent, [source]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Metro writer refuses changed serialization, illegal exports and unbounded modules", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rnr-metro-refuse-"));
  try {
    const options = {
      code: fixture(),
      outfile: resolve(root, "application.mjs"),
      exports: ["value"],
      entryModuleId: 0,
    };
    assert.throws(() => writeMetroModules({ ...options, maxModuleBytes: 50 }), /module budget/);
    assert.throws(() => writeMetroModules({ ...options, exports: ["default"] }), /export/);
    for (const name of ["eval", "arguments", "__r"])
      assert.throws(() => writeMetroModules({ ...options, exports: [name] }), /export/);
    assert.throws(
      () => writeMetroModules({ ...options, code: fixture().replace("__r(0);", "unexpected();") }),
      /Metro.*serialization/,
    );
    assert.throws(
      () => writeMetroModules({ ...options, code: "function invalid (" }),
      /Metro.*serialization/,
    );
    assert.throws(
      () => writeMetroModules({ ...options, code: fixture().replace("__r(0);", "__r(1);") }),
      /Metro.*entry/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
