import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readRokuConfig, generateSdkEntry, prepareRokuProject } from "./project.mjs";
test("config rejects absent entry/assets and generates literal native registration from data", () => {
  const root = mkdtempSync(resolve(tmpdir(), "roku-config-"));
  writeFileSync(resolve(root, "App.tsx"), "export default 1;");
  writeFileSync(
    resolve(root, "roku.config.json"),
    JSON.stringify({ name: "App", entry: "App.tsx" }),
  );
  assert.equal(readRokuConfig(root).name, "App");
  assert.equal(readRokuConfig(root).bundler, "esbuild");
  writeFileSync(
    resolve(root, "roku.config.json"),
    JSON.stringify({ name: "App", entry: "App.tsx", bundler: "unknown" }),
  );
  assert.throws(() => readRokuConfig(root), /frontend bundler/);
  writeFileSync(
    resolve(root, "roku.config.json"),
    JSON.stringify({ name: "App", entry: "Missing.tsx" }),
  );
  assert.throws(() => readRokuConfig(root), /entry is missing/);
  const result = generateSdkEntry({
    directory: resolve(root, "generated"),
    name: "Consumer",
    staticAssetsModule: "./imageAssets",
  });
  assert.equal(result.scene, "ConsumerScene");
  assert.match(
    readFileSync(resolve(root, "generated/RokuAnchor.ts"), "utf8"),
    /componentName:"ConsumerAnchor"/,
  );
  assert.match(result.mainSource, /ConsumerScene/);
  const anchor = readFileSync(resolve(root, "generated/RokuAnchor.ts"), "utf8");
  assert.match(anchor, /import \{staticAssets\} from "\.\/imageAssets"/);
  assert.match(anchor, /staticAssets\.some/);
  assert.throws(
    () => generateSdkEntry({ directory: root, name: "bad-name" }),
    /native application identifier/,
  );
});
test("generated native startup exposes whitelisted identity and ready/memory/error diagnostics", () => {
  const root = mkdtempSync(resolve(tmpdir(), "roku-build-identity-"));
  try {
    generateSdkEntry({
      directory: root,
      name: "Consumer",
      buildIdentity: {
        inputFingerprint: "a".repeat(64),
        runtimeSha256: "b".repeat(64),
        secret: "must-not-ship",
      },
    });
    const anchor = readFileSync(resolve(root, "RokuAnchor.ts"), "utf8");
    for (const marker of ["RNR_BUILD", "RNR_HOST_READY", "RNR_HOST_MEMORY", "ROKU_HOST_ERROR"])
      assert.ok(anchor.includes(marker), marker);
    const memory = /onMemorySnapshot:(info=>.+?),onError:/.exec(anchor)?.[1];
    assert.ok(memory, "Generated memory callback is missing");
    const messages = [];
    const emit = new Function("console", "return " + memory)({
      log: (marker, json) => messages.push([marker, JSON.parse(json)]),
    });
    emit({ availableKb: 2n ** 61n, usagePercent: 72, hermesHeap: { used: 42n } });
    assert.deepEqual(messages, [
      [
        "RNR_HOST_MEMORY",
        {
          availableKb: "2305843009213693952",
          usagePercent: 72,
          hermesHeap: { used: "42" },
        },
      ],
    ]);
    assert.ok(!anchor.includes("must-not-ship"));
    assert.throws(
      () => generateSdkEntry({ directory: root, buildIdentity: { inputFingerprint: "bad" } }),
      /Invalid build identity/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("standalone SDK preparation honors configured native identity and storage namespace", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "roku-configured-native-"));
  try {
    writeFileSync(resolve(root, "App.tsx"), "export default 1;");
    writeFileSync(resolve(root, "font.ttf"), "fixture-font");
    const config = {
      name: "ConfiguredApp",
      entry: "App.tsx",
      storageNamespace: "ConfiguredStorage",
      fonts: { defaultFamily: "Fixture", assets: { Fixture: "./font.ttf" } },
    };
    const writeConfig = (value) =>
      writeFileSync(resolve(root, "roku.config.json"), JSON.stringify(value));
    writeConfig(config);
    const result = await prepareRokuProject(root, { frontend: false });
    assert.equal(result.profile, "production");
    assert.equal(
      JSON.parse(readFileSync(resolve(result.directory, "build-profile.json"))).profile,
      "production",
    );
    const development = await prepareRokuProject(root, { frontend: false, profile: "development" });
    assert.equal(development.directory, resolve(root, ".roku/development"));
    assert.equal(development.profile, "development");
    assert.equal(
      JSON.parse(readFileSync(resolve(result.directory, "build-profile.json"))).profile,
      "production",
    );
    await assert.rejects(
      prepareRokuProject(root, { frontend: false, profile: "typo" }),
      /Choose Roku profile/,
    );
    assert.equal(result.native.scene, "ConfiguredAppScene");
    assert.match(
      readFileSync(resolve(result.generated, "RokuAnchor.ts"), "utf8"),
      /storageNamespace:"ConfiguredStorage"/,
    );
    for (const invalid of [
      { ...config, displayName: 7 },
      { ...config, displayName: "bad\ntitle" },
      { ...config, storageNamespace: "" },
    ]) {
      writeConfig(invalid);
      assert.throws(() => readRokuConfig(root), /single-line string/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("logical font families survive standalone configuration and native generation", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "roku-configured-faces-"));
  try {
    writeFileSync(resolve(root, "App.tsx"), "export default 1;");
    writeFileSync(resolve(root, "regular.ttf"), "regular fixture");
    writeFileSync(resolve(root, "bold.ttf"), "bold fixture");
    const fonts = {
      defaultFamily: "Body",
      assets: { Regular: "./regular.ttf", Bold: "./bold.ttf" },
      families: { Body: { normal: { 400: "Regular", 700: "Bold" } } },
    };
    const writeConfig = () =>
      writeFileSync(
        resolve(root, "roku.config.json"),
        JSON.stringify({
          name: "FontConsumer",
          entry: "App.tsx",
          fonts,
        }),
      );
    writeConfig();
    const result = await prepareRokuProject(root, { frontend: false });
    assert.deepEqual(JSON.parse(JSON.stringify(result.fonts.families)), fonts.families);
    const anchor = readFileSync(resolve(result.generated, "RokuAnchor.ts"), "utf8");
    assert.ok(anchor.includes(`families:${JSON.stringify(fonts.families)}`));
    assert.deepEqual(
      readFileSync(result.fonts.assets.Bold),
      readFileSync(resolve(root, "bold.ttf")),
    );
    fonts.families.Body.normal[700] = "Missing";
    writeConfig();
    assert.throws(() => readRokuConfig(root), /C04_FONT_FACE_CONFIG/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the esbuild React Compiler is opt-in and Metro retains its Babel configuration", () => {
  const root = mkdtempSync(resolve(tmpdir(), "roku-react-compiler-"));
  const config = (options) => {
    writeFileSync(
      resolve(root, "roku.config.json"),
      JSON.stringify({ name: "App", entry: "App.tsx", ...options }),
    );
    return readRokuConfig(root);
  };
  try {
    writeFileSync(resolve(root, "App.tsx"), "export default function App() { return null; }");
    assert.equal(config({}).reactCompiler, undefined);
    assert.equal(config({ reactCompiler: true }).reactCompiler, true);
    assert.equal(config({ reactCompiler: false, bundler: "metro" }).reactCompiler, false);
    assert.throws(() => config({ reactCompiler: "true" }), /boolean/);
    assert.throws(() => config({ reactCompiler: true, bundler: "metro" }), /Metro Babel/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
