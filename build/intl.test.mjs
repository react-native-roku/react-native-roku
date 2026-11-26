import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { prepareIntlDataModules } from "./intl.mjs";
import { buildRokuReactModules } from "./frontend.mjs";
import { rokuPlugin } from "./esbuild.mjs";

test("bounded English profile preserves native Intl without decoding fallback tables", async () => {
  const temporary = mkdtempSync(resolve(tmpdir(), "rnr-intl-native-"));
  const parse = JSON.parse,
    native = Intl.Collator;
  let largeDecodes = 0;
  try {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const output = resolve(temporary, "profile.mjs");
    const result = await buildRokuReactModules({
      absWorkingDir: root,
      entryPoints: [resolve(root, "src/services/intlEnglish.ts")],
      outfile: output,
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2021",
      plugins: [rokuPlugin({ root, generatedDirectory: resolve(temporary, "generated") })],
    });
    assert.ok(
      Object.values(result.metafile.outputs).every((file) => file.bytes <= 2 * 1024 * 1024),
    );
    JSON.parse = (value, ...args) => {
      if (typeof value === "string" && value.length > 100000) largeDecodes++;
      return parse(value, ...args);
    };
    const module = await import(pathToFileURL(output));
    assert.equal(module.configureIntlTimeZone().source, "native");
    assert.equal(Intl.Collator, native);
    assert.equal(largeDecodes, 0);
  } finally {
    JSON.parse = parse;
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Intl static data chunks preserve Unicode, arrays, object order and original dependency bytes", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "rnr-intl-data-"));
  try {
    const input = resolve(root, "source.mjs"),
      output = resolve(root, "prepared.mjs");
    const value = {
      rows: Array.from({ length: 100 }, (_, n) => [n, "café 😀", -n - 1]),
      valid: true,
      missing: null,
    };
    const code = `const data=${JSON.stringify(value)};const parsed=JSON.parse(${JSON.stringify(JSON.stringify(value))});export {data,parsed};`;
    writeFileSync(input, code);
    const prepared = prepareIntlDataModules(input, resolve(root, "generation"), {
      threshold: 100,
      chunkCharacters: 31,
    });
    writeFileSync(output, prepared.contents);
    const module = await import(pathToFileURL(output));
    assert.deepEqual(module.data, value);
    assert.deepEqual(module.parsed, value);
    assert.equal(readFileSync(input, "utf8"), code);
    const snapshot = prepareIntlDataModules(input, resolve(root, "snapshot"), {
      threshold: 100,
      chunkCharacters: 31,
      source: code.replace("export {data,parsed};", "export {data,parsed};\n// captured source"),
    });
    assert.ok(snapshot.contents.endsWith("// captured source"));
    assert.ok(prepared.files.length > 10);
    assert.ok(prepared.files.every((path) => path.startsWith(resolve(root, "generation"))));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("Intl extraction refuses executable data, unsafe keys and name collisions", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rnr-intl-data-"));
  try {
    const path = resolve(root, "source.mjs");
    for (const code of [
      "const data={key:doWork()};",
      'const data={"__proto__":true};',
      "const __rnrIntlData0=1;const data={key:123456789};",
    ]) {
      writeFileSync(path, code);
      assert.throws(() =>
        prepareIntlDataModules(path, root, { threshold: 1, chunkCharacters: 10 }),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
