import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import { exerciseYoga, prepareHermesYoga } from "./yoga.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(ROOT, "package.json"));
const binding = require.resolve("yoga-layout-prebuilt/yoga-layout/build/Release/nbind.js");

test("Yoga preparation uses the transform's source snapshot and refuses changed bindings", () => {
  const source = readFileSync(binding, "utf8");
  assert.throws(
    () => prepareHermesYoga(binding, { source: source.replace("eval(", "changedEval(") }),
    /pinned Yoga binding changed/,
  );
  const prepared = prepareHermesYoga(binding, {
    source: source + "\n// immutable input snapshot\n",
  });
  assert.ok(prepared.contents.endsWith("// immutable input snapshot\n"));
  assert.equal(readFileSync(binding, "utf8"), source);
});

test("prepared Yoga bindings work with eval, Function and WebAssembly unavailable", () => {
  const prepared = prepareHermesYoga(binding),
    module = { exports: {} };
  const forbidden = () => {
    throw new Error("Dynamic code execution was attempted");
  };
  vm.runInNewContext(prepared.contents, {
    module,
    exports: module.exports,
    require: createRequire(binding),
    console,
    setTimeout,
    clearTimeout,
    process: undefined,
    eval: forbidden,
    Function: forbidden,
    WebAssembly: undefined,
  });
  let native;
  module.exports({}, (error, value) => {
    if (error) throw error;
    native = value;
  });
  const Yoga = require("yoga-layout-prebuilt/yoga-layout/dist/entry-common.js")(
    native.bind,
    native.lib,
  );
  exerciseYoga(Yoga);
  assert.deepEqual(prepared.signatures, {
    buildCallerFunction: 14,
    buildJSCallerFunction: 3,
  });
  const Reference = require("yoga-layout-prebuilt");
  function geometry(engine, seed) {
    const root = engine.Node.create(),
      children = [];
    try {
      root.setWidth(300 + (seed % 31));
      root.setHeight(200);
      root.setFlexDirection(seed % 2 ? engine.FLEX_DIRECTION_ROW : engine.FLEX_DIRECTION_COLUMN);
      root.setPadding(engine.EDGE_ALL, seed % 9);
      root.setJustifyContent(seed % 3 ? engine.JUSTIFY_CENTER : engine.JUSTIFY_SPACE_BETWEEN);
      for (let index = 0; index < 4; index++) {
        const node = engine.Node.create();
        children.push(node);
        node.setWidth(20 + index * 4);
        node.setHeight(12 + (seed % 7));
        node.setFlexGrow(index === seed % 4 ? 1 : 0);
        node.setMargin(engine.EDGE_ALL, index + (seed % 3));
        root.insertChild(node, index);
      }
      root.calculateLayout(
        undefined,
        undefined,
        seed % 2 ? engine.DIRECTION_LTR : engine.DIRECTION_RTL,
      );
      return JSON.parse(
        JSON.stringify([root, ...children].map((node) => node.getComputedLayout())),
      );
    } finally {
      root.freeRecursive();
    }
  }
  for (let seed = 0; seed < 250; seed++)
    assert.deepEqual(geometry(Yoga, seed), geometry(Reference, seed));
});
