import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { packageRoot } from "../build/index.mjs";
import { toolchain } from "../build/environment.mjs";
import { ensureQualificationStorage } from "./qualificationStorage.mjs";

await ensureQualificationStorage({ projectRoot: packageRoot });

// Optional, finite local lane. Installs its own tools; no workspace node_modules
// links, device access, native hot reload.
const evidence = resolve(process.env.ROKU_QUALIFY_EVIDENCE_DIR ?? resolve(packageRoot, ".local"));
mkdirSync(evidence, { recursive: true });
const directory = mkdtempSync(resolve(evidence, "metro-consumer-"));
const report = {
  status: "running",
  directory,
  deviceQualified: false,
  limits: [
    "Public production/development Metro frontend and project/SDK builder with bounded Intl modules; Fast Refresh and native execution remain unqualified.",
    "Text, scene and system observations use explicit host fixtures.",
  ],
};
const save = () =>
  writeFileSync(resolve(directory, "proof.json"), JSON.stringify(report, null, 2) + "\n");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function assertImageValues(actual, expected) {
  assert.ok(Array.isArray(actual));
  assert.equal(actual.length, expected.length);
  assert.ok(actual.every((value) => typeof value === "string"));
  // Hash comparisons preserve exact byte checking and keep a failed assertion
  // from attempting to format megabytes of binary/string diff into memory.
  assert.deepEqual(actual.map(sha), expected.map(sha));
}
let command = 0;
function run(program, args, cwd, environment = {}) {
  const result = spawnSync(program, args, {
    cwd,
    encoding: "utf8",
    timeout: 300000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, CI: "1", ...environment },
  });
  writeFileSync(
    resolve(directory, `command-${++command}.log`),
    (result.stdout ?? "") + "\n" + (result.stderr ?? ""),
  );
  assert.equal(
    result.status,
    0,
    result.error?.stack ??
      `Command failed: ${program} ${args.join(" ")}; see command-${command}.log`,
  );
  return result.stdout;
}
save();
try {
  const inputs = resolve(directory, "inputs");
  mkdirSync(inputs);
  const helperPaths = [
    "scripts/qualify-metro-consumer.mjs",
    "config/toolchain.json",
    ...readdirSync(resolve(packageRoot, "examples/metro/src")).map(
      (name) => "examples/metro/src/" + name,
    ),
  ];
  const helpers = helperPaths.map((path) => {
    const bytes = readFileSync(resolve(packageRoot, path));
    mkdirSync(dirname(resolve(inputs, path)), { recursive: true });
    writeFileSync(resolve(inputs, path), bytes);
    return { path, sha256: sha(bytes) };
  });
  writeFileSync(resolve(inputs, "files.json"), JSON.stringify(helpers, null, 2));
  const archive = resolve(process.env.ROKU_QUALIFY_ARCHIVE ?? resolve(directory, "platform.tgz"));
  if (!process.env.ROKU_QUALIFY_ARCHIVE) run("pnpm", ["pack", "--out", archive], packageRoot);
  copyFileSync(archive, resolve(directory, "selected-platform.tgz"));
  report.archiveSha256 = sha(readFileSync(archive));
  const unpacked = resolve(directory, "unpacked");
  mkdirSync(unpacked);
  run("tar", ["-xzf", archive, "-C", unpacked], directory);
  const consumer = resolve(directory, "consumer");
  run(
    process.execPath,
    [
      resolve(unpacked, "package/bin/react-native-roku.mjs"),
      "init",
      consumer,
      "--bundler=metro",
      `--package=file:${resolve(directory, "selected-platform.tgz")}`,
    ],
    directory,
  );
  const manifestPath = resolve(consumer, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath));
  Object.assign(manifest.devDependencies, toolchain.optionalPackages.metro, {
    "react-native-css-interop": "0.2.6",
    "qrcode-generator": "2.0.4",
    tailwindcss: "3.4.19",
  });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  run("pnpm", ["install", "--prefer-offline", "--ignore-scripts"], consumer);
  const require = createRequire(manifestPath);
  const installed = await import(pathToFileURL(require.resolve("react-native-roku/build")));
  assert.ok(
    installed.packageRoot.startsWith(consumer + "/"),
    "Platform must be independently installed",
  );
  report.versions = {};
  for (const [name, version] of Object.entries(toolchain.optionalPackages.metro)) {
    const actual = require(name + "/package.json").version;
    assert.equal(
      actual,
      version.startsWith("npm:") ? version.slice(version.lastIndexOf("@") + 1) : version,
      name,
    );
    report.versions[name] = actual;
  }
  const qrRoot = resolve(dirname(require.resolve("qrcode-generator")), "..");
  assert.equal(JSON.parse(readFileSync(resolve(qrRoot, "package.json"))).version, "2.0.4");
  report.versions["qrcode-generator"] = "2.0.4";
  for (const name of ["package.json", "dist/qrcode.mjs"]) {
    const target = resolve(inputs, "qrcode-generator", name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(qrRoot, name), target);
  }
  for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"])
    copyFileSync(resolve(consumer, name), resolve(inputs, name));
  const original = await import(pathToFileURL(resolve(unpacked, "package/build/index.mjs")));
  const implementation = installed.runtimeInputs().filter((file) => file.path !== "package.json");
  assert.deepEqual(
    implementation,
    original.runtimeInputs().filter((file) => file.path !== "package.json"),
  );
  report.installedFilesVerified = implementation.length;
  writeFileSync(resolve(inputs, "installed-files.json"), JSON.stringify(implementation, null, 2));
  for (const file of implementation) {
    const target = resolve(inputs, "installed", file.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(installed.packageRoot, file.path), target);
  }
  report.consumer = consumer;
  save();
  cpSync(resolve(inputs, "examples/metro/src"), resolve(consumer, "src"), { recursive: true });
  const { cssToReactNativeRuntime } = require("react-native-css-interop/css-to-rn");
  const css = cssToReactNativeRuntime(
    Buffer.from(
      ".metro-box{width:320px;height:120px;padding:8px}.metro-input{width:200px;height:30px}.metro-input:focus{border-color:red}",
    ),
  );
  writeFileSync(
    resolve(consumer, "src/styles.ts"),
    `import {StyleSheet} from 'react-native-css-interop';StyleSheet.registerCompiled(${JSON.stringify(css)});\n`,
  );
  writeFileSync(
    resolve(consumer, "babel.config.cjs"),
    "module.exports={presets:['@react-native/babel-preset']};\n",
  );
  writeFileSync(
    resolve(consumer, "transformer.cjs"),
    "const {withRokuBabelTransformer}=require('react-native-roku/metro');module.exports=withRokuBabelTransformer(require('@react-native/metro-babel-transformer'),{root:__dirname});\n",
  );
  writeFileSync(
    resolve(consumer, "metro.config.cjs"),
    "const {getDefaultConfig,mergeConfig}=require('@react-native/metro-config');const {withRoku}=require('react-native-roku/metro');module.exports=withRoku(mergeConfig(getDefaultConfig(__dirname),{projectRoot:__dirname,watchFolders:[__dirname],maxWorkers:1,resolver:{useWatchman:false},transformer:{babelTransformerPath:require.resolve('./transformer.cjs')}}));\n",
  );
  writeFileSync(
    resolve(consumer, "src/index.ts"),
    "import App from './App';import './styles';import {AppRegistry} from 'react-native';import {mountRegisteredApplication} from 'react-native-roku/application';globalThis.__rokuMetroFactory=context=>mountRegisteredApplication(context,{appKey:'MetroProof',load(){AppRegistry.registerComponent('MetroProof',()=>App)}});\n",
  );
  const { buildRokuMetroModules } = await import(
    pathToFileURL(require.resolve("react-native-roku/build/frontend"))
  );
  const { rokuBuildProfile } = await import(
    pathToFileURL(require.resolve("react-native-roku/build/environment"))
  );
  const { build } = require("esbuild");
  const project = await import(pathToFileURL(require.resolve("react-native-roku/build/project")));
  // A separate tiny graph checks the public asset inventory on a cold build
  // and a transform-cache hit. The fixture supplies its explicit asset port;
  // this does not claim default SDK image packaging or native pixels.
  const sharp = createRequire(resolve(consumer, "node_modules/@roku-sdk/tooling/package.json"))(
    "sharp",
  );
  const raster = await sharp({ create: { width: 2, height: 3, channels: 4, background: "red" } })
    .png()
    .toBuffer();
  writeFileSync(resolve(consumer, "src/inventory.png"), raster);
  const raster2x = await sharp({ create: { width: 4, height: 6, channels: 4, background: "red" } })
    .png()
    .toBuffer();
  writeFileSync(resolve(consumer, "src/inventory@2x.png"), raster2x);
  writeFileSync(
    resolve(consumer, "src/assets.d.ts"),
    'declare module "*.png" {const image: {uri:string;width:number;height:number};export default image;}\n',
  );
  writeFileSync(
    resolve(consumer, "src/assetInventory.ts"),
    'import image from "./inventory.png";export function qualify(){return image;}\n',
  );
  const assetRegistry = resolve(consumer, "fixture-asset-registry.mjs"),
    assetPlugin = resolve(consumer, "fixture-asset-plugin.cjs");
  writeFileSync(
    assetRegistry,
    "export function registerAsset(data){return {uri:data.fixtureURI,width:data.width,height:data.height};}\n",
  );
  writeFileSync(
    assetPlugin,
    'module.exports=data=>({...data,fixtureURI:"pkg:/images/fixture.png"});\n',
  );
  const assetInputs = resolve(directory, "asset-inputs");
  mkdirSync(assetInputs);
  for (const path of [
    "src/inventory.png",
    "src/inventory@2x.png",
    "src/assets.d.ts",
    "src/assetInventory.ts",
    "fixture-asset-registry.mjs",
    "fixture-asset-plugin.cjs",
  ]) {
    const target = resolve(assetInputs, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(consumer, path), target);
  }
  const assetBuilds = [];
  for (let round = 0; round < 2; round++) {
    const frontend = await buildRokuMetroModules({
      root: consumer,
      entry: "src/assetInventory.ts",
      outfile: resolve(directory, "asset-frontend.mjs"),
      workDirectory: resolve(directory, "asset-metro"),
      exports: ["qualify"],
      configuration: {
        projectRoot: consumer,
        watchFolders: [consumer],
        maxWorkers: 1,
        resolver: { useWatchman: false },
        transformer: { assetRegistryPath: assetRegistry, assetPlugins: [assetPlugin] },
      },
    });
    assert.equal(frontend.assets.length, 1);
    const asset = frontend.assets[0];
    assert.equal(asset.width, 2);
    assert.equal(asset.height, 3);
    assert.equal(asset.type, "png");
    assert.equal(asset.fixtureURI, "pkg:/images/fixture.png");
    assert.deepEqual(asset.scales, [1, 2]);
    assert.deepEqual(asset.files, [
      resolve(consumer, "src/inventory.png"),
      resolve(consumer, "src/inventory@2x.png"),
    ]);
    assert.deepEqual(readFileSync(asset.files[0]), raster);
    assert.deepEqual(readFileSync(asset.files[1]), raster2x);
    assert.ok(
      Object.keys(frontend.metafile.inputs).some((path) => path.endsWith("src/inventory.png")),
    );
    const program = await import(pathToFileURL(frontend.outfile).href + `?round=${round}`);
    assert.deepEqual(program.qualify(), { uri: "pkg:/images/fixture.png", width: 2, height: 3 });
    assetBuilds.push({
      round,
      assets: frontend.assets,
      sourceInputs: Object.keys(frontend.metafile.inputs).length,
    });
  }
  report.assetInventory = assetBuilds;
  // Qualify the installed package's own compiler, including transform-cache
  // restoration and density selection when a 1x source does not exist.
  const { createRokuImageAssets } = await import(
    pathToFileURL(require.resolve("react-native-roku/build/assets"))
  );
  const denseRaster = await sharp({
    create: { width: 8, height: 12, channels: 4, background: "blue" },
  })
    .png()
    .toBuffer();
  writeFileSync(resolve(consumer, "src/density@0.5x.png"), raster);
  writeFileSync(resolve(consumer, "src/density@2x.png"), denseRaster);
  const embeddedURI = `data:image/png;base64,${raster.toString("base64")}`;
  // The real library constructs GIF URLs from a MIME prefix at runtime. A
  // prefix is not a complete image literal for the static raster compiler.
  const qrInput = "https://example.invalid/pair/metro-qualification";
  const qrSource = `import qrcode from 'qrcode-generator';const qr=qrcode(0,'M');qr.addData(${JSON.stringify(qrInput)});qr.make();export const pairingQR={modules:qr.getModuleCount(),svg:qr.createSvgTag({cellSize:2,margin:4}),dataURL:qr.createDataURL(2,4)};\n`;
  writeFileSync(resolve(consumer, "src/qr.ts"), qrSource);
  copyFileSync(resolve(consumer, "src/qr.ts"), resolve(assetInputs, "src/qr.ts"));
  const referenceQR = require("qrcode-generator")(0, "M");
  referenceQR.addData(qrInput);
  referenceQR.make();
  const expectedQR = {
    modules: referenceQR.getModuleCount(),
    svg: referenceQR.createSvgTag({ cellSize: 2, margin: 4 }),
    dataURL: referenceQR.createDataURL(2, 4),
  };
  const imageEntry = "src/packagedImages.ts";
  writeFileSync(
    resolve(consumer, imageEntry),
    `import density from './density.png';import {pairingQR} from './qr';const embedded='${embeddedURI}';export function qualifyImages(){return {density,embedded,pairingQR};}\n`,
  );
  const imageDirectory = resolve(directory, "packaged-images");
  const imageBuilds = [];
  for (let round = 0; round < 2; round++) {
    if (round) {
      rmSync(resolve(imageDirectory, "assets"), { recursive: true, force: true });
      rmSync(resolve(imageDirectory, "asset-metadata"), { recursive: true, force: true });
    }
    const frontend = await buildRokuMetroModules({
      root: consumer,
      entry: imageEntry,
      outfile: resolve(directory, `packaged-images-${round}.mjs`),
      exports: ["qualifyImages"],
      workDirectory: resolve(directory, "packaged-images-metro"),
      imageAssets: { generatedDirectory: imageDirectory },
      configuration: {
        projectRoot: consumer,
        watchFolders: [consumer],
        maxWorkers: 1,
        resolver: { useWatchman: false },
      },
    });
    const value = (
      await import(pathToFileURL(frontend.outfile).href + `?round=${round}`)
    ).qualifyImages();
    assert.equal(value.embedded, embeddedURI);
    assert.deepEqual(value.pairingQR, expectedQR);
    assert.ok(frontend.sources.some((path) => path.endsWith("qrcode-generator/dist/qrcode.mjs")));
    assert.deepEqual(value.density, {
      uri: `pkg:/images/asset-${sha(denseRaster).slice(0, 24)}.png`,
      width: 4,
      height: 6,
    });
    assert.deepEqual(frontend.assets[0].scales, [0.5, 2]);
    assert.equal(Object.keys(frontend.imageAssets).length, 2);
    for (const bytes of [raster, denseRaster])
      assert.deepEqual(
        readFileSync(resolve(imageDirectory, "assets", `asset-${sha(bytes).slice(0, 24)}.png`)),
        bytes,
      );
    const compiler = createRokuImageAssets({ root: consumer, generatedDirectory: imageDirectory });
    assert.equal(compiler.writeSdkModule(resolve(imageDirectory, "images.ts")).size, 2);
    imageBuilds.push({ round, frontend, value });
  }
  report.packagedImages = imageBuilds;
  save();
  const fence =
    "var nativeFunctionPrototype=Function.prototype;function noDynamicFunction(){throw new Error('Dynamic Function execution is forbidden');}noDynamicFunction.prototype=nativeFunctionPrototype;nativeFunctionPrototype.constructor=noDynamicFunction;globalThis.Function=noDynamicFunction;globalThis.eval=undefined;globalThis.WebAssembly=undefined;try{Function('return 1');throw new Error('Dynamic Function was admitted');}catch(error){if(error.message!=='Dynamic Function execution is forbidden')throw error;}try{new Function('return 1');throw new Error('Dynamic constructor was admitted');}catch(error){if(error.message!=='Dynamic Function execution is forbidden')throw error;}\n";
  // A large, valid image-data module exceeds the SDK factory budget before
  // extraction. Keep every authored value and the existing 2 MiB code ceiling.
  const largeRasters = [];
  for (const background of ["red", "blue"])
    largeRasters.push(
      await sharp({ create: { width: 512, height: 512, channels: 4, background } })
        .png({ compressionLevel: 0 })
        .toBuffer(),
    );
  const largeValues = largeRasters.map(
    (bytes) => `data:image/png;base64,${bytes.toString("base64")}`,
  );
  const largeEntry = "src/largeEmbedded.ts";
  const largeSource = `const images=${JSON.stringify(largeValues)};export function qualifyLargeImages(){return images;}\n`;
  assert.ok(Buffer.byteLength(largeSource) > 2 * 1024 * 1024);
  writeFileSync(resolve(consumer, largeEntry), largeSource);
  copyFileSync(resolve(consumer, largeEntry), resolve(assetInputs, largeEntry));
  const largeDirectory = resolve(directory, "large-embedded");
  const largeImages = resolve(largeDirectory, "images");
  const largeBuilds = [];
  let largeFrontend;
  for (let round = 0; round < 2; round++) {
    if (round) rmSync(largeImages, { recursive: true, force: true });
    largeFrontend = await buildRokuMetroModules({
      root: consumer,
      entry: largeEntry,
      outfile: resolve(largeDirectory, `frontend-${round}.mjs`),
      exports: ["qualifyLargeImages"],
      workDirectory: resolve(largeDirectory, "metro"),
      imageAssets: { generatedDirectory: largeImages },
      configuration: {
        projectRoot: consumer,
        watchFolders: [consumer],
        maxWorkers: 1,
        resolver: { useWatchman: false },
      },
    });
    assert.ok(largeFrontend.imagePreparationPasses >= 2);
    assert.ok(
      largeFrontend.files
        .filter((f) => f.path.endsWith(".mjs"))
        .every((f) => f.bytes <= 2 * 1024 * 1024),
    );
    const actual = (await import(pathToFileURL(largeFrontend.outfile).href)).qualifyLargeImages();
    assertImageValues(actual, largeValues);
    assert.equal(Object.keys(largeFrontend.imageAssets).length, 2);
    for (const bytes of largeRasters)
      assert.equal(
        sha(readFileSync(resolve(largeImages, "assets", `asset-${sha(bytes).slice(0, 24)}.png`))),
        sha(bytes),
      );
    largeBuilds.push({ round, frontend: largeFrontend });
  }
  const largeReport = {
    sourceBytes: Buffer.byteLength(largeSource),
    valueLengths: largeValues.map((v) => v.length),
    valueSha256: largeValues.map(sha),
    builds: largeBuilds,
  };
  if (process.env.ROKU_HERMES_EXECUTABLE) {
    const executable = resolve(process.env.ROKU_HERMES_EXECUTABLE),
      linked = resolve(largeDirectory, "linked.js"),
      runner = resolve(largeDirectory, "hermes-runner.js");
    await build({
      absWorkingDir: consumer,
      stdin: {
        contents: `import {qualifyLargeImages} from ${JSON.stringify(largeFrontend.outfile)};console.log('ROKU_LARGE_IMAGES '+JSON.stringify(qualifyLargeImages()));`,
        resolveDir: consumer,
        sourcefile: "large-image-host.js",
      },
      outfile: linked,
      bundle: true,
      format: "iife",
      platform: "neutral",
      target: "es2021",
      define: rokuBuildProfile("production").defines,
    });
    writeFileSync(runner, fence + readFileSync(linked, "utf8"));
    const stdout = run(
      executable,
      ["-w", "-Xes6-promise", "-Xmicrotask-queue", "-exec", runner],
      consumer,
    );
    assertImageValues(JSON.parse(stdout.split("ROKU_LARGE_IMAGES ")[1].trim()), largeValues);
    largeReport.hermes = {
      status: "passed",
      runnerSha256: sha(readFileSync(runner)),
      executableSha256: sha(readFileSync(executable)),
    };
  }
  // The same large module must survive the default SDK builder with real PNGs.
  const largeApp = "src/LargeApp.tsx";
  writeFileSync(
    resolve(consumer, largeApp),
    'import React from "react";import {Image} from "react-native";import {qualifyLargeImages} from "./largeEmbedded";export default function LargeApp(){return <Image source={qualifyLargeImages()[0]} style={{width:100,height:100}}/>;}\n',
  );
  copyFileSync(resolve(consumer, largeApp), resolve(assetInputs, largeApp));
  const configPath = resolve(consumer, "roku.config.json"),
    beforeLarge = readFileSync(configPath);
  report.largeEmbedded = largeReport;
  largeReport.sdk = { status: "running" };
  save();
  try {
    writeFileSync(
      configPath,
      JSON.stringify({ ...JSON.parse(beforeLarge), entry: largeApp, entryMode: "component" }),
    );
    const built = await project.buildRokuProject(consumer, { profile: "production" });
    const snapshot = resolve(largeDirectory, "sdk-project");
    cpSync(resolve(consumer, ".roku"), snapshot, { recursive: true });
    copyFileSync(built.zip, resolve(largeDirectory, "sdk.zip"));
    const sdkImages = [];
    for (const bytes of largeRasters) {
      const name = `asset-${sha(bytes).slice(0, 24)}.png`;
      const extracted = spawnSync("unzip", ["-p", built.zip, `images/${name}`], {
        maxBuffer: 4 * 1024 * 1024,
      });
      assert.equal(extracted.status, 0);
      assert.equal(sha(extracted.stdout), sha(readFileSync(resolve(built.bundle, "images", name))));
      const original = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const actual = await sharp(extracted.stdout)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      assert.deepEqual(actual.info, original.info);
      assert.equal(sha(actual.data), sha(original.data), "SDK changed decoded PNG pixels");
      sdkImages.push({
        name,
        width: actual.info.width,
        height: actual.info.height,
        pixelSha256: sha(actual.data),
        sourceEncodingSha256: sha(bytes),
        archiveEncodingSha256: sha(extracted.stdout),
      });
    }
    largeReport.sdk = {
      status: "compiled",
      images: sdkImages,
      zipSha256: sha(readFileSync(built.zip)),
      programSha256: sha(
        readFileSync(resolve(snapshot, "dist/sdk/bundle/source/compiled/index.js")),
      ),
    };
  } finally {
    writeFileSync(configPath, beforeLarge);
  }
  report.largeEmbedded = largeReport;
  save();
  // Add ordinary image use to the original state/effect/CSS/Intl fixture. The
  // same tree executes on Node/Hermes and enters the default SDK project path.
  const appEmbeddedURI = `data:image/png;base64,${raster.toString("base64")}`;
  const appPath = resolve(consumer, "src/App.tsx");
  let appSource = readFileSync(appPath, "utf8");
  assert.ok(appSource.includes('import { Text, View, TextInput } from "react-native";'));
  assert.ok(appSource.includes("<Text>{value}</Text>"));
  appSource = appSource
    .replace(
      'import { Text, View, TextInput } from "react-native";',
      `import { Text, View, TextInput, Image } from "react-native";\nimport raster from './density.png';\nimport {pairingQR} from './qr';\nexport const authoredImage='${appEmbeddedURI}';`,
    )
    .replace(
      "<Text>{value}</Text>",
      "<Text>{value}</Text><Text>QR {pairingQR.modules}</Text><Image source={raster} style={{width:20,height:30}}/><Image source={authoredImage} style={{width:20,height:30}}/>",
    );
  writeFileSync(appPath, appSource);
  const qualifyPath = resolve(consumer, "src/qualify.ts");
  let qualifySource = readFileSync(qualifyPath, "utf8");
  assert.ok(qualifySource.includes("    const cold = texts();"));
  qualifySource =
    `import {authoredImage} from './App';import {pairingQR} from './qr';\n` +
    qualifySource
      .replace(
        "    const cold = texts();",
        `    const cold = texts();\n    const images=[...scene.nodes.values()].filter(node=>node.type==='poster').map(node=>node.fields.uri);\n    if(images.length!==2||images.some(uri=>typeof uri!=='string'||!uri.startsWith('pkg:/images/asset-')))throw Error('Metro images did not reach the Poster adapter');\n    if(authoredImage!==${JSON.stringify(appEmbeddedURI)})throw Error('Metro changed the authored image value');`,
      )
      .replace(
        "      cold,",
        "      cold,\n      images,\n      pairingQR,\n      authoredImagePreserved:true,",
      );
  writeFileSync(qualifyPath, qualifySource);
  for (const name of [
    "App.tsx",
    "qualify.ts",
    "packagedImages.ts",
    "density@0.5x.png",
    "density@2x.png",
  ]) {
    const target = resolve(assetInputs, "src", name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(consumer, "src", name), target);
  }
  const profiles = [];
  for (const development of [false, true]) {
    const profile = development ? "development" : "production";
    const output = resolve(directory, profile);
    mkdirSync(output);
    const bundle = resolve(output, "qualification.mjs");
    const frontend = await buildRokuMetroModules({
      root: consumer,
      entry: "src/qualify.ts",
      outfile: bundle,
      profile,
      workDirectory: resolve(output, "metro"),
      exports: ["qualify"],
      imageAssets: { generatedDirectory: resolve(output, "images") },
      configuration: {
        projectRoot: consumer,
        watchFolders: [consumer],
        maxWorkers: 1,
        resolver: { useWatchman: false },
      },
    });
    assert.equal(frontend.sources.filter((path) => /react\/index\.js$/.test(path)).length, 1);
    assert.equal(
      frontend.sources.filter((path) => path.endsWith(`/react.${profile}.js`)).length,
      1,
    );
    assert.ok(
      !frontend.sources.some((path) =>
        path.endsWith(`/react.${development ? "production" : "development"}.js`),
      ),
      "Metro retained the opposite React implementation",
    );
    assert.ok(!frontend.sources.some((path) => /react-native\/Libraries\//.test(path)));
    assert.ok(frontend.intl.some((entry) => entry.files.length > 0));
    const emitted = new Set(
      Object.values(frontend.metafile.outputs).flatMap((output) =>
        Object.entries(output.inputs)
          .filter(([, input]) => input.bytesInOutput > 0)
          .map(([path]) => path),
      ),
    );
    assert.ok(emitted.has("src/App.tsx"), "Metro metadata lost the original component source");
    assert.ok(emitted.has("src/qualify.ts"), "Metro metadata lost its original entry source");
    assert.deepEqual(
      frontend.metafile.outputs[relative(consumer, bundle)].inputs,
      {},
      "The loader must not claim to contain its dependency factories",
    );
    for (const file of frontend.files)
      assert.equal(frontend.metafile.outputs[relative(consumer, file.path)].bytes, file.bytes);
    assert.ok(
      frontend.files
        .filter((file) => file.path.endsWith(".mjs"))
        .every((file) => file.bytes <= 2 * 1024 * 1024),
    );
    const runner = resolve(output, "host-runner.cjs");
    const invoke =
      "result=>console.log('ROKU_METRO_PASS '+JSON.stringify(result)),error=>{console.error(error.stack??String(error));throw error;}";
    writeFileSync(
      runner,
      fence +
        `import(${JSON.stringify(pathToFileURL(bundle).href)}).then(module=>module.qualify()).then(${invoke});\n`,
    );
    const stdout = run(process.execPath, [runner], consumer, {
      NODE_ENV: development ? "production" : "development",
    });
    assert.match(stdout, /ROKU_METRO_PASS /);
    const result = {
      profile,
      modules: frontend.modules,
      frontend,
      host: JSON.parse(stdout.split("ROKU_METRO_PASS ")[1].trim()),
    };
    assert.deepEqual(result.host.pairingQR, expectedQR);
    if (process.env.ROKU_HERMES_EXECUTABLE) {
      const executable = resolve(process.env.ROKU_HERMES_EXECUTABLE);
      const linked = resolve(output, "hermes-linked.js");
      await build({
        absWorkingDir: consumer,
        stdin: {
          contents: `import {qualify} from ${JSON.stringify(bundle)};qualify().then(${invoke});`,
          resolveDir: consumer,
          sourcefile: "host-entry.js",
        },
        outfile: linked,
        bundle: true,
        format: "iife",
        platform: "neutral",
        target: "es2021",
        define: rokuBuildProfile(profile).defines,
        sourcemap: true,
      });
      const hermesRunner = resolve(output, "hermes-runner.js");
      writeFileSync(hermesRunner, fence + readFileSync(linked, "utf8"));
      const stdout = run(
        executable,
        ["-w", "-Xes6-promise", "-Xmicrotask-queue", "-exec", hermesRunner],
        consumer,
      );
      assert.match(stdout, /ROKU_METRO_PASS /);
      result.hermes = {
        executableSha256: sha(readFileSync(executable)),
        runnerSha256: sha(readFileSync(hermesRunner)),
        scope:
          "Public partitioned Metro frontend linked for the host VM with esbuild; no SDK/native execution",
        host: JSON.parse(stdout.split("ROKU_METRO_PASS ")[1].trim()),
      };
      assert.deepEqual(result.hermes.host.pairingQR, expectedQR);
    } else result.hermes = { status: "not-requested" };
    // Exercise the public project builder with both ordinary entry conventions.
    writeFileSync(
      resolve(consumer, "src/index.ts"),
      "import App from './App';import {AppRegistry} from 'react-native';AppRegistry.registerComponent('MetroProof',()=>App);\n",
    );
    writeFileSync(
      resolve(consumer, "roku.config.json"),
      JSON.stringify({
        ...JSON.parse(readFileSync(resolve(consumer, "roku.config.json"))),
        name: "MetroProof",
        entry: development ? "src/App.tsx" : "src/index.ts",
        entryMode: development ? "component" : "registry",
        bundler: "metro",
      }),
    );
    const built = await project.buildRokuProject(consumer, { profile });
    run("unzip", ["-tqq", built.zip], consumer);
    copyFileSync(built.zip, resolve(output, "metro-sdk.zip"));
    const generated = resolve(consumer, ".roku", development ? "development" : ".");
    const metadata = JSON.parse(
      readFileSync(resolve(generated, "src/generated/frontend.metro.json")),
    );
    assert.ok(
      metadata.files
        .filter((file) => file.path.endsWith(".mjs"))
        .every((file) => file.bytes <= 2 * 1024 * 1024),
    );
    assert.equal(metadata.profile, profile);
    assert.ok(metadata.sources.some((path) => path.endsWith("qrcode-generator/dist/qrcode.mjs")));
    assert.equal(
      JSON.parse(readFileSync(resolve(built.bundle, "build-profile.json"))).profile,
      profile,
    );
    assert.ok(
      readdirSync(resolve(built.bundle, "fonts")).filter((name) => name.endsWith(".ttf")).length >=
        8,
      "Metro project lost configured regular/bold/italic or tabular font assets",
    );
    assert.equal(Object.keys(metadata.imageAssets).length, 2);
    for (const bytes of [raster, denseRaster]) {
      const name = `asset-${sha(bytes).slice(0, 24)}.png`;
      assert.deepEqual(readFileSync(resolve(built.bundle, "images", name)), bytes);
      const extracted = spawnSync("unzip", ["-p", built.zip, `images/${name}`], {
        maxBuffer: 1024 * 1024,
      });
      assert.equal(extracted.status, 0);
      assert.deepEqual(extracted.stdout, bytes, "SDK archive changed the packaged image");
    }
    cpSync(resolve(consumer, "src"), resolve(output, "application-inputs"), { recursive: true });
    cpSync(generated, resolve(output, "sdk-project"), { recursive: true });
    result.sdk = {
      status: "compiled",
      entryMode: development ? "component" : "registry",
      programSha256: sha(readFileSync(resolve(built.bundle, "source/compiled/index.js"))),
      zipSha256: sha(readFileSync(built.zip)),
      frontend: metadata,
    };
    profiles.push(result);
    report.profiles = profiles;
    save();
  }
  const preview = await project.buildRokuPreview(consumer, {
    outputDirectory: resolve(directory, "image-preview"),
    profile: "production",
  });
  for (const bytes of [raster, denseRaster])
    assert.deepEqual(
      readFileSync(resolve(preview, "assets", `asset-${sha(bytes).slice(0, 24)}.png`)),
      bytes,
    );
  report.imagePreview = {
    status: "prepared",
    directory: preview,
    scope: "Browser resource bytes; Canvas pixels/native image presentation remain separate",
  };
  for (const helper of helpers)
    assert.equal(
      sha(readFileSync(resolve(packageRoot, helper.path))),
      helper.sha256,
      `Qualification helper changed: ${helper.path}`,
    );
  assert.deepEqual(
    installed.runtimeInputs().filter((file) => file.path !== "package.json"),
    implementation,
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  save();
  writeFileSync(
    resolve(evidence, "metro-consumer-proof.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
}
