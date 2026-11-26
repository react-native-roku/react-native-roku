import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { packageRoot, runtimeInputs } from "../build/index.mjs";
import { ensureQualificationStorage } from "./qualificationStorage.mjs";
await ensureQualificationStorage({ projectRoot: packageRoot });
const temporary = mkdtempSync(resolve(tmpdir(), "react-native-roku-consumer-"));
function run(args, cwd = packageRoot) {
  const result = spawnSync("pnpm", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  if (result.status !== 0) throw Error(result.stdout + "\n" + result.stderr);
  return result;
}
const evidence = resolve(process.env.ROKU_QUALIFY_EVIDENCE_DIR ?? resolve(packageRoot, ".local"));
const archive = process.env.ROKU_QUALIFY_ARCHIVE
  ? resolve(process.env.ROKU_QUALIFY_ARCHIVE)
  : resolve(temporary, "react-native-roku.tgz");
if (!process.env.ROKU_QUALIFY_ARCHIVE) run(["pack", "--out", archive]);
const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
assert.equal(listing.status, 0);
assert.doesNotMatch(listing.stdout, /node_modules|\.test\.|\.git\/|\.local\//);
const consumer = resolve(temporary, "consumer");
mkdirSync(consumer);
writeFileSync(
  resolve(consumer, "package.json"),
  JSON.stringify({
    name: "independent-roku-consumer",
    private: true,
    type: "module",
    packageManager: "pnpm@11.23.0",
    dependencies: {
      "react-native-roku": `file:${archive}`,
      react: "19.2.8",
      "@types/react": "19.2.18",
      typescript: "npm:@typescript/typescript6@6.0.2",
      "@typescript/native": "npm:typescript@7.0.2",
      esbuild: "0.28.1",
      "@napi-rs/canvas": "1.1.0",
      "@expo-google-fonts/inter": "0.4.2",
    },
  }),
);
writeFileSync(
  resolve(consumer, "pnpm-workspace.yaml"),
  "nodeLinker: hoisted\nautoInstallPeers: false\n",
);
run(["install", "--prefer-offline", "--ignore-scripts"], consumer);
cpSync(resolve(packageRoot, "examples/minimal/src"), resolve(consumer, "src"), {
  recursive: true,
});
writeFileSync(
  resolve(consumer, "tsconfig.json"),
  JSON.stringify({
    extends: "react-native-roku/tsconfig",
    include: ["src"],
  }),
);
const typed = spawnSync(
  resolve(consumer, "node_modules/.bin/tsc"),
  ["--noEmit", "-p", resolve(consumer, "tsconfig.json")],
  { cwd: consumer, encoding: "utf8" },
);
if (typed.status !== 0) throw Error(typed.stdout + "\n" + typed.stderr);

const require = createRequire(resolve(consumer, "package.json"));
const { build } = await import(pathToFileURL(require.resolve("esbuild")));
const helpers = await import(pathToFileURL(require.resolve("react-native-roku/build")));
assert.ok(!helpers.packageRoot.startsWith(packageRoot));
assert.deepEqual(
  helpers.runtimeInputs().filter((entry) => entry.path !== "package.json"),
  runtimeInputs().filter((entry) => entry.path !== "package.json"),
  "Packed installed implementation must exactly match source inputs",
);
const { packageManager, ...sourceManifest } = JSON.parse(
  readFileSync(resolve(packageRoot, "package.json")),
);
assert.ok(packageManager);
// pnpm omits publish-only hooks from installed archives as well as packageManager.
delete sourceManifest.scripts.prepublishOnly;
assert.deepEqual(
  JSON.parse(readFileSync(resolve(helpers.packageRoot, "package.json"))),
  sourceManifest,
  "Only pnpm's packageManager and prepublishOnly normalization is allowed",
);

assert.throws(() => require.resolve("react-native-roku/src/react-native/primitives.ts"), {
  code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
});
const native = helpers.prepareNativeComponents(resolve(consumer, "generated"));
assert.equal(native.files.length, 10);
await build({
  entryPoints: [resolve(consumer, "src/qualify.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: resolve(consumer, "proof.cjs"),
  jsx: "automatic",
  plugins: [
    (await import(pathToFileURL(require.resolve("react-native-roku/build/esbuild")))).rokuPlugin({
      root: consumer,
    }),
  ],
});
const result = await require(resolve(consumer, "proof.cjs")).qualify();
await build({
  entryPoints: [resolve(consumer, "src/nodeTesting.mjs")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: resolve(consumer, "node-testing.cjs"),
  alias: { "react-native": helpers.resolveAdapter("react-native") },
});
result.nodeTesting = await require(resolve(consumer, "node-testing.cjs")).qualifyNodeTesting();
await build({
  entryPoints: [resolve(consumer, "src/previewAssets.mjs")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: resolve(consumer, "preview-assets.cjs"),
  external: ["@napi-rs/canvas"],
  alias: { "react-native": helpers.resolveAdapter("react-native") },
});
const consumerFont = require.resolve("@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf");
mkdirSync(resolve(consumer, "assets"));
cpSync(consumerFont, resolve(consumer, "assets/consumer-font.ttf"));
cpSync(
  resolve(dirname(consumerFont), "../LICENSE_FONT"),
  resolve(consumer, "assets/consumer-font.LICENSE"),
);
result.previewAssets = await require(resolve(consumer, "preview-assets.cjs")).qualifyPreviewAssets({
  fontURI: resolve(consumer, "assets/consumer-font.ttf"),
  imagePath: resolve(consumer, "assets/consumer-image.png"),
});
mkdirSync(evidence, { recursive: true });
writeFileSync(
  resolve(evidence, "consumer-proof.json"),
  JSON.stringify(
    {
      ...result,
      consumer,
      archive,
      archiveSha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
      nativeFiles: native.files.length,
      tools: {
        typescript: require("@typescript/native/package.json").version,
        esbuild: require("esbuild/package.json").version,
        scope: "Declared consumer dependencies; no producer/global compiler or bundler",
      },
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify({ ...result, nativeFiles: native.files.length, consumer }));
