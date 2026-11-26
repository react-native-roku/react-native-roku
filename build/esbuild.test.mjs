import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { rokuPlugin } from "./esbuild.mjs";
import { packageRoot } from "./index.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
const require = createRequire(import.meta.url);
test("the public frontend plugin resolves React once and rejects unadapted native/SDK imports", async () => {
  const compile = (contents) =>
    build({
      stdin: { contents, resolveDir: packageRoot },
      write: false,
      bundle: true,
      format: "esm",
      platform: "neutral",
      plugins: [rokuPlugin({ root: packageRoot })],
      logLevel: "silent",
      metafile: true,
    });
  const result = await compile(
    'export {View} from "react-native"; export {useState} from "react";',
  );
  const inputs = Object.keys(result.metafile.inputs);
  assert.equal(inputs.filter((path) => path.endsWith("react/cjs/react.development.js")).length, 1);
  assert.ok(inputs.some((path) => path.endsWith("src/react-native/primitives.ts")));
  await assert.rejects(
    compile('import "react-native/Libraries/Unknown";'),
    /Private React Native import/,
  );
  await assert.rejects(
    compile('import "@roku-sdk/runtime/lifecycle";'),
    /SDK mechanics belong in the bootstrap/,
  );
  assert.ok(require.resolve("react-native-roku/build/esbuild"));
});

test("source variants preserve package tree shaking metadata and keep effectful modules", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "roku-tree-shaking-"));
  const write = (path, contents) => {
    const target = resolve(root, path);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, contents);
  };
  try {
    write("package.json", '{"name":"consumer","type":"module"}');
    write(
      "node_modules/icons/package.json",
      '{"name":"icons","type":"module","main":"index.js","sideEffects":false}',
    );
    write(
      "node_modules/icons/index.js",
      'export {Used} from "./used.js";export {Unused} from "./unused.js";',
    );
    write("node_modules/icons/used.js", 'export const Used="wrong-shared-source";');
    write("node_modules/icons/used.roku.js", 'export const Used="selected-roku-source";');
    write(
      "node_modules/icons/unused.js",
      "globalThis.UNUSED_ICON_SIDE_EFFECT();export const Unused=1;",
    );
    write("effects.js", "globalThis.APPLICATION_SIDE_EFFECT();");
    const result = await build({
      stdin: {
        contents: 'import "./effects.js";export {Used} from "icons";',
        resolveDir: root,
      },
      bundle: true,
      write: false,
      format: "esm",
      plugins: [rokuPlugin({ root })],
    });
    const text = result.outputFiles[0].text;
    assert.match(text, /selected-roku-source/);
    assert.match(text, /APPLICATION_SIDE_EFFECT/);
    assert.doesNotMatch(text, /UNUSED_ICON_SIDE_EFFECT|wrong-shared-source/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
