import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { packageRoot } from "../build/index.mjs";
import { openTestBrowser, until, pause } from "./browserHarness.mjs";
import { ensureQualificationStorage } from "./qualificationStorage.mjs";

await ensureQualificationStorage({ projectRoot: packageRoot });

const evidence = resolve(process.env.ROKU_QUALIFY_EVIDENCE_DIR ?? resolve(packageRoot, ".local"));
mkdirSync(evidence, { recursive: true });
const directory = mkdtempSync(resolve(evidence, "fast-refresh-"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = {
  status: "running",
  directory,
  deviceQualified: false,
  stages: [],
  limits: [
    "Actual installed public development server and browser Canvas host. Native refresh, decoding, input/presentation and firmware remain separately unqualified.",
  ],
};
const save = () =>
  writeFileSync(resolve(directory, "proof.json"), JSON.stringify(report, null, 2) + "\n");
let command = 0,
  browser,
  server,
  stage = "setup",
  root;
function run(program, args, cwd) {
  const result = spawnSync(program, args, {
    cwd,
    encoding: "utf8",
    timeout: 300000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, CI: "1" },
  });
  writeFileSync(
    resolve(directory, `command-${++command}.log`),
    (result.stdout ?? "") + "\n" + (result.stderr ?? ""),
  );
  assert.equal(
    result.status,
    0,
    result.error?.stack ?? `Command failed; inspect command-${command}.log`,
  );
}
const counter = (
  label,
  { extra = false, moduleError = false, renderError = false, resource = false } = {},
) => `
import React,{useState,useEffect} from 'react';import {Pressable,Text} from 'react-native';
${moduleError ? "declare const unknownRefreshBinding:number;const missing=unknownRefreshBinding;" : ""}
${resource ? "const resource=new Map();" : ""}
export default function Counter(){const[count,setCount]=useState(0);${extra ? "const[extra]=useState(false);" : ""}
useEffect(()=>{const world=globalThis as unknown as {__refreshEffects?:{setups:number;cleanups:number}};const stats=world.__refreshEffects??={setups:0,cleanups:0};stats.setups++;return()=>{stats.cleanups++;};},[]);
${renderError ? "throw Error('refresh render failed');" : ""}
return <Pressable nativeID="refresh-counter" hasTVPreferredFocus onPress={()=>setCount(value=>value+1)} style={{width:500,height:100,backgroundColor:'#3456c0'}}><Text style={{fontSize:32,color:'white'}}>{'${label} '+count}</Text></Pressable>;}
Counter.displayName='Counter';
`;
save();
try {
  const inputs = resolve(directory, "inputs");
  mkdirSync(inputs);
  const helpers = ["scripts/qualify-fast-refresh.mjs", "scripts/browserHarness.mjs"].map((path) => {
    const bytes = readFileSync(resolve(packageRoot, path)),
      target = resolve(inputs, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    return { path, sha256: sha(bytes) };
  });
  writeFileSync(resolve(inputs, "helpers.json"), JSON.stringify(helpers, null, 2));
  const archive = resolve(process.env.ROKU_QUALIFY_ARCHIVE ?? resolve(directory, "platform.tgz"));
  if (!process.env.ROKU_QUALIFY_ARCHIVE) run("pnpm", ["pack", "--out", archive], packageRoot);
  copyFileSync(archive, resolve(directory, "selected-platform.tgz"));
  report.archiveSha256 = sha(readFileSync(archive));
  const unpacked = resolve(directory, "unpacked");
  mkdirSync(unpacked);
  run("tar", ["-xzf", archive, "-C", unpacked], directory);
  root = resolve(directory, "consumer");
  report.consumer = root;
  run(
    process.execPath,
    [
      resolve(unpacked, "package/bin/react-native-roku.mjs"),
      "init",
      root,
      "--bundler=metro",
      `--package=file:${resolve(directory, "selected-platform.tgz")}`,
    ],
    directory,
  );
  run("pnpm", ["install", "--prefer-offline", "--ignore-scripts"], root);
  const require = createRequire(resolve(root, "package.json"));
  const installed = await import(pathToFileURL(require.resolve("react-native-roku/build")));
  assert.ok(installed.packageRoot.startsWith(root + "/"));
  const original = await import(pathToFileURL(resolve(unpacked, "package/build/index.mjs")));
  const installedInputs = installed.runtimeInputs();
  assert.deepEqual(installedInputs, original.runtimeInputs());
  for (const file of installedInputs) {
    const target = resolve(inputs, "installed", file.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(installed.packageRoot, file.path), target);
  }
  writeFileSync(resolve(inputs, "installed-files.json"), JSON.stringify(installedInputs, null, 2));
  for (const file of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "metro.config.cjs",
    "babel.config.cjs",
    "roku.config.json",
  ])
    if (existsSync(resolve(root, file))) copyFileSync(resolve(root, file), resolve(inputs, file));
  const sharp = createRequire(resolve(root, "node_modules/@roku-sdk/tooling/package.json"))(
    "sharp",
  );
  const pixel = await sharp({ create: { width: 2, height: 3, channels: 4, background: "red" } })
    .png()
    .toBuffer();
  writeFileSync(resolve(root, "src/pixel.png"), pixel);
  writeFileSync(
    resolve(root, "src/App.tsx"),
    `import React from 'react';import {View,Image}from'react-native';import Counter from './Counter';import pixel from './pixel.png';export default function App(){return <View style={{width:800,height:600,padding:40}}><Counter/><Image source={pixel} style={{width:20,height:30}}/></View>;}\n`,
  );
  const source = resolve(root, "src/Counter.tsx");
  writeFileSync(source, counter("Before"));
  const initialConfig = JSON.parse(readFileSync(resolve(root, "roku.config.json")));
  writeFileSync(
    resolve(root, "src/index.ts"),
    `import App from './App';import {AppRegistry}from'react-native';AppRegistry.registerComponent(${JSON.stringify(initialConfig.name)},()=>App);\n`,
  );
  run("pnpm", ["typecheck"], root);
  const { createRokuProjectDevServer } = await import(
    pathToFileURL(require.resolve("react-native-roku/build/project"))
  );
  const events = [];
  stage = "development-server-start";
  server = await createRokuProjectDevServer(root, {
    port: 0,
    onBuild: (event) => {
      events.push(event);
      if (events.length > 256) events.shift();
    },
  });
  report.url = server.url;
  report.workspace = server.workspaceDirectory;
  browser = await openTestBrowser("about:blank");
  await browser.call("Runtime.enable");
  await browser.call("Page.enable");
  await browser.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `const prototype=Function.prototype;function forbidden(){throw Error('Dynamic code is forbidden');}forbidden.prototype=prototype;prototype.constructor=forbidden;globalThis.Function=forbidden;globalThis.eval=undefined;globalThis.WebAssembly=undefined;globalThis.__refreshWindow=crypto.randomUUID();`,
  });
  await browser.call("Page.navigate", { url: server.url });
  const snapshot = () =>
    browser.evaluate(
      `({app:window.__ROKU_DEV__?.snapshot(),effects:window.__refreshEffects,window:window.__refreshWindow,panel:document.querySelector('#roku-build-status')?.textContent,status:document.querySelector('#status')?.textContent})`,
    );
  const text = async (value) =>
    until(
      async () => {
        const state = await snapshot();
        return state.app?.texts.includes(value) && state;
      },
      { timeout: 90000 },
    );
  async function capture(name) {
    stage = name;
    const state = await snapshot(),
      generation = server.snapshot().generation;
    const target = resolve(directory, "stages", String(report.stages.length) + "-" + name);
    mkdirSync(target, { recursive: true });
    for (const file of [
      "src/App.tsx",
      "src/Counter.tsx",
      "src/index.ts",
      "src/pixel.png",
      "roku.config.json",
    ]) {
      const dest = resolve(target, "inputs", file);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(resolve(root, file), dest);
    }
    const output = resolve(server.workspaceDirectory, String(generation));
    for (const file of ["preview.js", "preview.js.map", "index.html"])
      if (existsSync(resolve(output, file)))
        copyFileSync(resolve(output, file), resolve(target, file));
    if (existsSync(resolve(output, "refresh")))
      for (const file of readdirSync(resolve(output, "refresh"))) {
        mkdirSync(resolve(target, "refresh"), { recursive: true });
        copyFileSync(resolve(output, "refresh", file), resolve(target, "refresh", file));
      }
    const resources = resolve(directory, "resources");
    mkdirSync(resources, { recursive: true });
    for (const folder of ["fonts", "assets"])
      if (existsSync(resolve(output, folder)))
        for (const file of readdirSync(resolve(output, folder))) {
          const path = resolve(output, folder, file),
            bytes = readFileSync(path),
            name = sha(bytes) + "-" + file;
          if (!existsSync(resolve(resources, name))) writeFileSync(resolve(resources, name), bytes);
        }
    const record = { name, generation, state, server: server.snapshot(), directory: target };
    report.stages.push(record);
    save();
    return state;
  }
  async function edit(name, contents, expected, { reload = false, error = false } = {}) {
    stage = name;
    const before = await snapshot(),
      generation = server.snapshot().generation;
    writeFileSync(source, contents);
    await until(
      () => server.snapshot().state === "ready" && server.snapshot().generation > generation,
      { timeout: 90000 },
    );
    await until(
      async () => {
        const state = await snapshot();
        return (
          state.app?.refresh?.generation === server.snapshot().generation &&
          !state.app.refresh.pending
        );
      },
      { timeout: 90000 },
    );
    const after = expected ? await text(expected) : await snapshot();
    assert.equal(after.window === before.window, !reload, `${name}: unexpected page lifetime`);
    assert.equal(Boolean(after.app.refresh.error), error, `${name}: unexpected runtime error`);
    return capture(name);
  }
  stage = "cold-render";
  const cold = await text("Before 0");
  assert.equal(typeof cold.window, "string", "The pre-document page identity must be installed");
  assert.ok(cold.window.length > 20);
  assert.equal(
    await browser.evaluate(
      `(()=>{try{Function('return 1');return false;}catch(error){return error.message==='Dynamic code is forbidden'&&typeof eval==='undefined'&&typeof WebAssembly==='undefined';}})()`,
    ),
    true,
    "The runtime must execute behind the dynamic-code fence",
  );
  await capture(stage);
  const press = async () => {
    await browser.evaluate(
      "window.__ROKU_DEV__.remote({key:'select',phase:'down'});window.__ROKU_DEV__.remote({key:'select',phase:'up'});",
    );
  };
  await pause(100);
  await press();
  await text("Before 1");
  await press();
  await text("Before 2");
  const changed = await edit("state-preserved", counter("After"), "After 2");
  assert.deepEqual(changed.effects, { setups: 2, cleanups: 1 });
  const changedDirectory = report.stages.at(-1).directory;
  const patchFiles = readdirSync(resolve(changedDirectory, "refresh")).filter((name) =>
    name.endsWith(".mjs"),
  );
  assert.ok(patchFiles.length > 0);
  for (const file of patchFiles) {
    assert.ok(
      readFileSync(resolve(changedDirectory, "refresh", file)).byteLength <= 2 * 1024 * 1024,
    );
    const map = JSON.parse(readFileSync(resolve(changedDirectory, "refresh", file + ".map")));
    assert.ok(map.sources.some((path) => path.endsWith("Counter.tsx")));
    assert.ok(map.sourcesContent.includes(readFileSync(source, "utf8")));
  }
  await edit("module-error-retained", counter("Broken", { moduleError: true }), "After 2", {
    error: true,
  });
  await edit("module-error-corrected", counter("Fixed"), "Fixed 2");
  await edit("hook-signature-reset", counter("Reset", { extra: true }), "Reset 0");
  await edit("render-error", counter("Broken", { extra: true, renderError: true }), null, {
    error: true,
  });
  await edit("render-error-corrected", counter("Recovered", { extra: true }), "Recovered 0");
  const good = await snapshot(),
    generation = server.snapshot().generation;
  stage = "syntax-error-retained";
  writeFileSync(source, "export default function Counter( {");
  await until(() => server.snapshot().state === "error", { timeout: 90000 });
  const broken = await text("Recovered 0");
  assert.equal(broken.window, good.window);
  assert.equal(server.snapshot().generation, generation);
  await capture(stage);
  await edit("syntax-error-corrected", counter("Corrected", { extra: true }), "Corrected 0");
  await edit(
    "resource-full-reload",
    counter("Resource", { extra: true, resource: true }),
    "Resource 0",
    { reload: true },
  );
  await edit("resource-retirement-full-reload", counter("Retired", { extra: true }), "Retired 0", {
    reload: true,
  });
  stage = "asset-full-reload";
  const beforeAsset = await snapshot(),
    assetGeneration = server.snapshot().generation;
  const blue = await sharp({ create: { width: 2, height: 3, channels: 4, background: "blue" } })
    .png()
    .toBuffer();
  writeFileSync(resolve(root, "src/pixel.png"), blue);
  await until(
    () => server.snapshot().state === "ready" && server.snapshot().generation > assetGeneration,
    { timeout: 90000 },
  );
  await until(
    async () => {
      const state = await text("Retired 0");
      return state.window !== beforeAsset.window;
    },
    { timeout: 90000 },
  );
  await capture(stage);
  stage = "atomic-config-full-reload";
  const beforeConfig = await snapshot(),
    configGeneration = server.snapshot().generation;
  const config = JSON.parse(readFileSync(resolve(root, "roku.config.json")));
  config.viewport = { width: 810, height: 600 };
  writeFileSync(resolve(root, "replacement.json"), JSON.stringify(config));
  renameSync(resolve(root, "replacement.json"), resolve(root, "roku.config.json"));
  await until(
    () => server.snapshot().state === "ready" && server.snapshot().generation > configGeneration,
    { timeout: 90000 },
  );
  await until(
    async () => {
      const state = await text("Retired 0");
      return state.window !== beforeConfig.window;
    },
    { timeout: 90000 },
  );
  await capture(stage);
  stage = "font-full-reload";
  const beforeFont = await snapshot(),
    fontGeneration = server.snapshot().generation;
  const fontConfig = JSON.parse(readFileSync(resolve(root, "roku.config.json")));
  const defaultFamily = fontConfig.fonts.defaultFamily;
  const invalidFont = structuredClone(fontConfig);
  invalidFont.fonts.assets[defaultFamily] =
    "@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf";
  writeFileSync(resolve(root, "roku.config.json"), JSON.stringify(invalidFont));
  await until(() => server.snapshot().state === "error", { timeout: 90000 });
  assert.match(server.snapshot().error, /C04_FONT_FACE_CONFIG/);
  assert.equal((await text("Retired 0")).window, beforeFont.window);
  await capture("invalid-font-config-retained");
  stage = "font-full-reload";
  const physicalFamily =
    fontConfig.fonts.families?.[defaultFamily]?.normal?.["400"] ?? defaultFamily;
  assert.ok(Object.hasOwn(fontConfig.fonts.assets, physicalFamily));
  fontConfig.fonts.assets[physicalFamily] =
    "@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf";
  writeFileSync(resolve(root, "roku.config.json"), JSON.stringify(fontConfig));
  await until(
    () => server.snapshot().state === "ready" && server.snapshot().generation > fontGeneration,
    { timeout: 90000 },
  );
  await until(
    async () => {
      const state = await text("Retired 0");
      return state.window !== beforeFont.window;
    },
    { timeout: 90000 },
  );
  await capture(stage);
  stage = "busy-edit-coalescing";
  const busyGeneration = server.snapshot().generation,
    builds = server.snapshot().metrics.builds,
    beforeBusy = await snapshot();
  writeFileSync(source, counter("BusyBefore", { extra: true }));
  await until(() => server.snapshot().state === "building");
  writeFileSync(source, counter("BusyFinal", { extra: true }));
  await until(
    () => server.snapshot().state === "ready" && server.snapshot().generation > busyGeneration,
    { timeout: 90000 },
  );
  await text("BusyFinal 0");
  await server.idle();
  assert.equal((await snapshot()).window, beforeBusy.window);
  assert.ok(server.snapshot().metrics.builds >= builds + 2);
  await capture(stage);
  stage = "registry-entry-full-reload";
  const beforeRegistry = await snapshot(),
    registryGeneration = server.snapshot().generation;
  const registryConfig = JSON.parse(readFileSync(resolve(root, "roku.config.json")));
  registryConfig.entryMode = "registry";
  registryConfig.entry = "src/index.ts";
  writeFileSync(resolve(root, "roku.config.json"), JSON.stringify(registryConfig));
  await until(
    () => server.snapshot().state === "ready" && server.snapshot().generation > registryGeneration,
    { timeout: 90000 },
  );
  await until(
    async () => {
      const state = await text("BusyFinal 0");
      return state.window !== beforeRegistry.window;
    },
    { timeout: 90000 },
  );
  await capture(stage);
  await pause(100);
  await press();
  await text("BusyFinal 1");
  await edit("registry-state-preserved", counter("Registry", { extra: true }), "Registry 1");
  stage = "retirement";
  await browser.evaluate("window.__ROKU_DEV__.dispose()");
  const retired = await capture(stage);
  assert.equal(retired.app.disposed, true);
  assert.equal(retired.app.listeners, 0);
  assert.equal(retired.app.nodes, 1);
  assert.equal(retired.effects.setups, retired.effects.cleanups);
  assert.equal(await browser.evaluate("document.fonts.size"), 0);
  for (const helper of helpers)
    assert.equal(
      sha(readFileSync(resolve(packageRoot, helper.path))),
      helper.sha256,
      "Qualification helper changed",
    );
  assert.deepEqual(installed.runtimeInputs(), installedInputs);
  report.events = events;
  report.browser = browser.version;
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.stage = stage;
  report.failure = error.stack ?? String(error);
  process.exitCode = 1;
  if (browser) {
    try {
      report.failureSnapshot = await browser.evaluate(
        "({app:window.__ROKU_DEV__?.snapshot(),runtime:globalThis.__RNR_ROKU_REFRESH__?.snapshot(),window:window.__refreshWindow,effects:window.__refreshEffects,status:document.querySelector('#status')?.textContent,panel:document.querySelector('#roku-build-status')?.textContent})",
      );
    } catch {}
    report.browserEvents = browser.events;
  }
  if (server) report.server = server.snapshot();
  if (server) {
    const output = resolve(server.workspaceDirectory, String(server.snapshot().generation));
    const target = resolve(directory, "failed-generation");
    mkdirSync(target, { recursive: true });
    for (const file of ["preview.js", "preview.js.map", "index.html"])
      if (existsSync(resolve(output, file)))
        copyFileSync(resolve(output, file), resolve(target, file));
    if (existsSync(resolve(output, "refresh")))
      for (const file of readdirSync(resolve(output, "refresh"))) {
        mkdirSync(resolve(target, "refresh"), { recursive: true });
        copyFileSync(resolve(output, "refresh", file), resolve(target, "refresh", file));
      }
  }
} finally {
  await browser?.close();
  await server?.close();
  report.finishedAt = new Date().toISOString();
  save();
  writeFileSync(
    resolve(evidence, "fast-refresh-proof.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      status: report.status,
      directory,
      archiveSha256: report.archiveSha256,
      stage: report.stage,
      failure: report.failure,
    }),
  );
}
