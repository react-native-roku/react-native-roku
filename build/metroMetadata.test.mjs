import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { createMetroMetadata } from "./metroMetadata.mjs";
import { writeMetroModules } from "./metroModules.mjs";

test("Metro metadata attributes factories to their real chunks and preserves serializer hooks", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rnr-metro-metadata-"));
  try {
    let factories = 0,
      filters = 0;
    const paths = ["src/App.ts", "src/data.json", "runtime.js", "rejected.js"].map((name) =>
      resolve(root, name),
    );
    const runtime =
      "var __DEV__=false,process={env:{}};globalThis.__d=function(){};globalThis.__r=function(){return {mountApplication(){}}};\n";
    const code =
      runtime +
      `__d(function(g,r,a,b,m,e){e.data=r(0)},10,[11]);\n__d(function(g,r,a,b,m,e){m.exports={value:42}},11,[]);\n__r(10);\n`;
    const metadata = createMetroMetadata(root, {
      createModuleIdFactory() {
        factories++;
        return (name) => paths.indexOf(name) + 10;
      },
      processModuleFilter(module) {
        filters++;
        return module.path !== paths[3];
      },
    });
    const assign = metadata.serializer.createModuleIdFactory();
    const visit = (path, content, type, dependencies = []) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      return metadata.serializer.processModuleFilter({
        path,
        getSource: () => Buffer.from(content),
        dependencies: new Map(dependencies.map((value, index) => [String(index), value])),
        output: [{ type, data: { code: content } }],
      });
    };
    assign(paths[0]);
    assign(paths[1]);
    visit(paths[0], "import data from './data.json';export {data};", "js/module", [
      {
        absolutePath: paths[1],
        data: { name: "./data.json", data: { isESMImport: true, asyncType: null } },
      },
    ]);
    visit(paths[1], '{"value":42}', "js/module");
    visit(paths[2], runtime, "js/script");
    assert.equal(visit(paths[3], "throw Error('unused');", "js/module"), false);
    const result = writeMetroModules({
      code,
      outfile: resolve(root, "out/application.mjs"),
      metadata,
    });
    assert.equal(factories, 1);
    assert.equal(filters, 4);
    const meta = result.metafile;
    assert.deepEqual(meta.inputs["src/App.ts"].imports, [
      { path: "src/data.json", kind: "import-statement", original: "./data.json" },
    ]);
    assert.equal(meta.inputs["src/data.json"].bytes, 12);
    assert.ok(!meta.inputs["rejected.js"]);
    assert.deepEqual(meta.outputs["out/application.mjs"].inputs, {});
    const module = Object.entries(meta.outputs).find(([path]) => /module-0\.mjs$/.test(path));
    assert.ok(module[1].inputs["src/App.ts"].bytesInOutput > 0);
    assert.ok(
      module[1].inputs["src/data.json"].bytesInOutput > 0,
      "JSON without a source map still needs its real module identity",
    );
    for (const output of Object.values(meta.outputs))
      assert.ok(
        Object.values(output.inputs).reduce((sum, input) => sum + input.bytesInOutput, 0) <=
          output.bytes,
      );
    assert.equal(Object.keys(meta.inputs).length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("embedded asset restoration uses the emitted module's immutable Metro snapshot", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rnr-metro-image-snapshot-"));
  try {
    const path = resolve(root, "image.ts");
    const original = 'export const image="data:image/png;base64,c25hcHNob3Q=";';
    writeFileSync(path, original);
    const metadata = createMetroMetadata(root, {
      createModuleIdFactory: () => () => 0,
      processModuleFilter: () => true,
    });
    metadata.serializer.processModuleFilter({
      path,
      getSource: () => Buffer.from(original),
      dependencies: new Map(),
      output: [{ type: "js/module", data: { code: original } }],
    });
    writeFileSync(path, 'export const image="data:image/png;base64,bmV3ZXI=";');
    assert.deepEqual(metadata.embeddedSources({ "image.ts": {} }), [{ path, source: original }]);
    assert.deepEqual(metadata.embeddedSources({}), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Metro metadata refuses conflicting module IDs and missing serializer evidence", () => {
  const metadata = createMetroMetadata("/fixture", {
    createModuleIdFactory: () => () => 0,
    processModuleFilter: () => true,
  });
  const assign = metadata.serializer.createModuleIdFactory();
  assign("/fixture/a.js");
  assert.throws(() => assign("/fixture/b.js"), /module ID/);
  assert.throws(() => metadata.moduleInput(99, 10), /Unattested Metro module/);
});
