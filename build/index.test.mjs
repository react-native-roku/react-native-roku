import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  adapterModules,
  resolveAdapter,
  prepareNativeComponents,
  runtimeInputs,
} from "./index.mjs";
test("public adapter manifest resolves every supported integration", () => {
  assert.equal(Object.keys(adapterModules).length, 14);
  for (const name of Object.keys(adapterModules)) assert.ok(resolveAdapter(name));
  assert.equal(resolveAdapter("unsupported-native-module"), null);
});
test("native package assets use one registration manifest and generate consumer imports", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "roku-native-"));
  const result = prepareNativeComponents(directory);
  assert.equal(result.files.length, 10);
  const imports = readFileSync(resolve(directory, "nativeComponents.ts"), "utf8");
  for (const name of Object.values(result.components)) {
    assert.match(imports, new RegExp(name + "\\.xml"));
    assert.match(
      readFileSync(resolve(directory, "native-components", name + ".xml"), "utf8"),
      new RegExp('name="' + name + '"'),
    );
  }
  assert.doesNotMatch(imports, /from ["'](?:\.\.\/|\/)/);
});
test("fingerprint contains implementation, build and native sources in stable order", () => {
  const values = runtimeInputs();
  assert.deepEqual(values, runtimeInputs());
  for (const prefix of ["src/", "build/", "native/"])
    assert.ok(values.some((value) => value.path.startsWith(prefix)));
  assert.ok(values.every((value) => /^[a-f0-9]{64}$/.test(value.sha256)));
});
