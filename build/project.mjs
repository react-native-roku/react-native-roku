import { createRokuDevWorkspace } from "./devWorkspace.mjs";
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, rmSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { buildRokuReactModules, buildRokuMetroModules } from "./frontend.mjs";
import {
  doctorEnvironment,
  rokuBuildProfile,
  installedPackage,
  toolchain,
} from "./environment.mjs";
import { rokuPlugin } from "./esbuild.mjs";
import { appReactCompiler } from "./reactCompiler.mjs";
import { prepareNativeComponents } from "./index.mjs";
import { normalizeRokuBuildIdentity } from "./identity.mjs";
import { prepareRokuFontAssets } from "./fontVariants.mjs";
import { fontVariantFamily } from "../src/layout/fontVariants.mjs";
import { fontFaceFamily, prepareFontFamilies } from "../src/layout/fontFaces.mjs";
import { createRokuImageAssets } from "./assets.cjs";
import { buildSurfaceAssets } from "./surfaces.mjs";
import { createHash } from "node:crypto";
import { runtimeInputs } from "./index.mjs";
import { createRokuMetroRefreshSession, writeRokuRefreshBootstrap } from "./metroRefresh.mjs";
export { prepareRokuFontAssets } from "./fontVariants.mjs";
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const developmentConfigFiles = [
  "roku.config.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.react.json",
  "transformer.js",
  "transformer.cjs",
  ...["metro", "babel"].flatMap((name) =>
    ["js", "cjs", "mjs"].map((extension) => `${name}.config.${extension}`),
  ),
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function readRokuConfig(root = process.cwd()) {
  const path = resolve(root, "roku.config.json");
  if (!existsSync(path))
    throw Error("Missing roku.config.json. Start with react-native-roku init.");
  const value = json(path),
    name = value.name;
  if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name))
    throw Error("Roku configuration needs an identifier containing letters, digits or underscores");
  if (value.entryMode && !["component", "registry", "mount"].includes(value.entryMode))
    throw Error("Unknown Roku entryMode");
  if (value.bundler !== undefined && !["esbuild", "metro"].includes(value.bundler))
    throw Error("Unknown Roku frontend bundler; choose esbuild or metro");
  if (value.reactCompiler !== undefined && typeof value.reactCompiler !== "boolean")
    throw Error("reactCompiler must be a boolean");
  if (value.reactCompiler && value.bundler === "metro")
    throw Error("Configure React Compiler in the Metro Babel config");
  for (const field of ["displayName", "storageNamespace"])
    if (
      value[field] !== undefined &&
      (typeof value[field] !== "string" || !value[field].trim() || /[\r\n]/.test(value[field]))
    )
      throw Error(`Roku ${field} must be a nonempty single-line string`);
  const entry = value.entry ?? "src/App.tsx";
  if (typeof entry !== "string" || !existsSync(resolve(root, entry)))
    throw Error(`Roku entry is missing: ${entry}`);
  const fonts = value.fonts ?? {
    defaultFamily: "Inter",
    assets: {
      Inter: "@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf",
    },
  };
  if (
    typeof fonts.defaultFamily !== "string" ||
    !fonts.defaultFamily.trim() ||
    !fonts.assets ||
    typeof fonts.assets !== "object" ||
    Array.isArray(fonts.assets) ||
    !Object.keys(fonts.assets).length ||
    !Object.values(fonts.assets).every((value) => typeof value === "string" && value.length > 0)
  )
    throw Error("The default font must have a configured asset");
  fontFaceFamily(
    fonts.defaultFamily,
    {},
    fonts.assets,
    prepareFontFamilies(fonts.assets, fonts.families),
  );
  fontVariantFamily(fonts.defaultFamily, fonts.variants);
  const viewport = value.viewport ?? { width: 1920, height: 1080 };
  if (
    ![viewport.width, viewport.height].every(
      (number) => typeof number === "number" && Number.isFinite(number) && number > 0,
    )
  )
    throw Error("Roku viewport dimensions must be finite and positive");
  const background = value.background ?? "#101014";
  if (!/^#[a-fA-F0-9]{6}$/.test(background))
    throw Error("Roku background must be a six-digit hex color");
  return {
    ...value,
    name,
    entry,
    fonts,
    viewport,
    background,
    displayName: value.displayName ?? name,
    entryMode: value.entryMode ?? "component",
    bundler: value.bundler ?? "esbuild",
  };
}
export function resolveProjectFont(root, specifier) {
  const require = createRequire(resolve(root, "package.json"));
  return specifier.startsWith(".") || specifier.startsWith("/")
    ? resolve(root, specifier)
    : require.resolve(specifier);
}
/** Generate only SDK mechanics. Existing applications can supply their own mount export. */
export function generateSdkEntry({
  directory,
  name = "RokuApplication",
  displayName = name,
  mountModule = "./application.mjs",
  mountExport = "mountApplication",
  mountOptions = {},
  fontsModule = "./fontAssets",
  defaultFamily = "Inter",
  fontFamilies = {},
  componentsModule = "./nativeComponents",
  viewport = { width: 1920, height: 1080 },
  background = "#101014",
  storageNamespace = name,
  svgAtlasModule,
  cornerMasksModule,
  staticAssetsModule,
  buildIdentity,
}) {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name))
    throw Error("The native application identifier must contain letters, digits or underscores");
  const anchor = `${name}Anchor`,
    scene = `${name}Scene`;
  const identity =
    buildIdentity && normalizeRokuBuildIdentity({ ...buildIdentity, application: name });
  if (identity)
    write(resolve(directory, "build-identity.json"), JSON.stringify(identity, null, 2) + "\n");
  const assetImport = staticAssetsModule
    ? `import {staticAssets} from ${JSON.stringify(staticAssetsModule)};\n`
    : "";
  const assetValidation = staticAssetsModule
    ? 'if(staticAssets.some(asset=>!asset.uri.startsWith("pkg:/images/")))throw Error("Invalid packaged image URI");'
    : "";
  write(
    resolve(directory, "RokuAnchor.ts"),
    `import {defineAnchorNode} from "@roku-sdk/rsg-ts";\nimport {createRokuHost} from "react-native-roku/sdk-host";\nimport * as components from ${JSON.stringify(componentsModule)};\nimport {fontAssets} from ${JSON.stringify(fontsModule)};\nimport {${mountExport} as mount} from ${JSON.stringify(mountModule)};\n${svgAtlasModule ? `import {svgAtlas} from ${JSON.stringify(svgAtlasModule)};` : ""}\n${cornerMasksModule ? `import {cornerMasks} from ${JSON.stringify(cornerMasksModule)};` : ""}\n${assetImport}export default defineAnchorNode({componentName:${JSON.stringify(anchor)},extends:"Group",inputFields:{},outputFields:{}},()=>{${assetValidation}${identity ? `console.log("RNR_BUILD",${JSON.stringify(JSON.stringify(identity))});` : ""}return createRokuHost({onReady:info=>console.log("RNR_HOST_READY",JSON.stringify({application:${JSON.stringify(name)},...info})),onMemorySnapshot:info=>console.log("RNR_HOST_MEMORY",JSON.stringify(info,(_key,value)=>typeof value==="bigint"?value.toString():value)),onError:(error,phase)=>console.error("ROKU_HOST_ERROR",phase,error.message),components,fonts:{defaultFamily:${JSON.stringify(defaultFamily)},assets:fontAssets,families:${JSON.stringify(fontFamilies)}},viewport:${JSON.stringify(viewport)},storageNamespace:${JSON.stringify(storageNamespace)},${svgAtlasModule ? "svgAtlas," : ""}${cornerMasksModule ? "cornerMasks," : ""}mount:context=>mount({...context,...${JSON.stringify(mountOptions)},onError:(error:Error,kind:string)=>console.error("ROKU_RENDER_ERROR",kind,error.message)})});});\n`,
  );
  write(
    resolve(directory, "entry.ts"),
    `import "./native/${scene}.xml";\nimport {main,registerAnchorNode} from "@roku-sdk/rsg-ts";\nimport Anchor from "./RokuAnchor";\nmain(()=>registerAnchorNode(Anchor));\n`,
  );
  write(
    resolve(directory, `native/${scene}.xml`),
    `<?xml version="1.0" encoding="utf-8"?><component name="${scene}" extends="Scene" backExitsScene="true"><interface><field id="exitRequested" type="boolean" value="false" /></interface><children><${anchor} id="reactRoot" /></children><script type="text/brightscript" uri="${scene}.brs" /></component>`,
  );
  write(
    resolve(directory, `native/${scene}.brs`),
    `sub init()\n m.top.backgroundColor = "0x${background.slice(1)}FF"\n m.top.findNode("reactRoot").setFocus(true)\nend sub\n`,
  );
  return {
    anchor,
    scene,
    entry: resolve(directory, "entry.ts"),
    mainSource: rokuMainSource(scene),
  };
}
export async function prepareRokuProject(
  root = process.cwd(),
  { outputDirectory, frontend = true, profile = "production", refresh } = {},
) {
  const compilation = rokuBuildProfile(profile);
  outputDirectory ??= resolve(root, ".roku", compilation.development ? "development" : ".");
  const config = readRokuConfig(root),
    generated = resolve(outputDirectory, "src/generated");
  if (config.entryMode === "mount")
    throw Error(
      "A custom mount entry uses generateSdkEntry and createRokuSdkConfiguration in its existing build pipeline",
    );
  mkdirSync(generated, { recursive: true });
  prepareNativeComponents(generated);
  const preparedFonts = prepareRokuFontAssets({
    assets: Object.fromEntries(
      Object.entries(config.fonts.assets).map(([family, specifier]) => [
        family,
        resolveProjectFont(root, specifier),
      ]),
    ),
    variants: config.fonts.variants,
    families: config.fonts.families,
    outputDirectory: resolve(generated, "fonts"),
  });
  const assets = Object.entries(preparedFonts.assets);
  const fontImports = [];
  for (const [index, [, path]] of assets.entries()) {
    fontImports.push(
      `import font${index} from ${JSON.stringify("./" + relative(generated, path).split("\\").join("/"))};`,
    );
  }
  write(
    resolve(generated, "fontAssets.ts"),
    fontImports.join("\n") +
      `\nexport const fontAssets={${assets.map(([family], index) => `${JSON.stringify(family)}:font${index}`).join(",")}};\n`,
  );
  const key = JSON.stringify(config.name),
    entry = JSON.stringify(resolve(root, config.entry));
  if (refresh && (config.bundler !== "metro" || !compilation.development))
    throw Error("Fast Refresh requires the development Metro frontend");
  const imageDirectory = refresh ? resolve(refresh.session.directory, "images") : generated;
  const images = createRokuImageAssets({ root, generatedDirectory: imageDirectory, reset: true });
  let imageMetafile;
  let refreshGraph;
  const contents = `import {AppRegistry} from "react-native-roku/app-registry";import {mountRegisteredApplication} from "react-native-roku/application";import type {RokuHostContext} from "react-native-roku/host";\nexport function mountApplication(context:RokuHostContext){return mountRegisteredApplication(context,{appKey:${key},webRuntime:typeof document==='undefined'?'portable':'host',load(){const entry=require(${entry});${config.entryMode === "registry" ? "" : `AppRegistry.registerComponent(${key},()=>entry.default);`}}});}\n`;
  if (frontend) {
    await buildSurfaceAssets(root, generated);
    const entryPath = refresh
      ? resolve(refresh.session.directory, "application-entry.ts")
      : resolve(generated, "application-entry.ts");
    write(entryPath, contents);
    if (config.bundler === "metro") {
      const result = await buildRokuMetroModules({
        root,
        entry: entryPath,
        outfile: resolve(generated, "application.mjs"),
        profile,
        workDirectory: refresh
          ? resolve(refresh.session.directory, "metro")
          : resolve(outputDirectory, "metro"),
        imageAssets: { generatedDirectory: imageDirectory },
        refresh,
      });
      imageMetafile = result.metafile;
      refreshGraph = result.refreshGraph;
      write(resolve(generated, "frontend.metro.json"), JSON.stringify(result, null, 2));
    } else {
      const result = await buildRokuReactModules({
        absWorkingDir: root,
        entryPoints: [entryPath],
        outfile: resolve(generated, "application.mjs"),
        bundle: true,
        format: "esm",
        platform: "neutral",
        target: "es2021",
        jsx: "automatic",
        tsconfig: existsSync(resolve(root, "tsconfig.react.json"))
          ? resolve(root, "tsconfig.react.json")
          : undefined,
        define: compilation.defines,
        plugins: [
          images.esbuildPlugin(),
          rokuPlugin({ root, generatedDirectory: generated }),
          ...(config.reactCompiler
            ? [appReactCompiler(root, generated, profile === "production")]
            : []),
        ],
        metafile: true,
        sourcemap: true,
      });
      imageMetafile = result.metafile;
      write(resolve(generated, "frontend.metafile.json"), JSON.stringify(result.metafile, null, 2));
    }
  }
  const usedImageSources = new Set(
    Object.values(imageMetafile?.outputs ?? {}).flatMap((output) =>
      Object.entries(output.inputs)
        .filter(([, input]) => input.bytesInOutput > 0)
        .map(([path]) => path),
    ),
  );
  const imageAssets = images.writeSdkModule(resolve(generated, "imageAssets.ts"), usedImageSources);
  write(
    resolve(generated, "application.d.mts"),
    'import type {RokuHostContext,MountedRokuApplication} from "react-native-roku/host";export declare function mountApplication(context:RokuHostContext):MountedRokuApplication;\n',
  );
  const native = generateSdkEntry({
    directory: generated,
    name: config.name,
    defaultFamily: config.fonts.defaultFamily,
    fontFamilies: preparedFonts.families,
    viewport: config.viewport,
    background: config.background,
    storageNamespace: config.storageNamespace ?? config.name,
    staticAssetsModule: "./imageAssets",
    ...(frontend ? { cornerMasksModule: "./surfaceAssets" } : {}),
  });
  write(resolve(outputDirectory, "pkg/source/Main.brs"), native.mainSource);

  write(
    resolve(outputDirectory, "roku-config.ts"),
    `import type {RokuConfig} from "@roku-sdk/rsg-ts/roku-config";export default {outDir:"dist/sdk",app:{entryPoint:"src/generated/entry.ts",images:{convertToWebp:false,generateHd:false},manifestEntries:{title:${JSON.stringify(config.displayName)},major_version:0,minor_version:1,build_version:0,ui_resolutions:"fhd",rsg_version:"2.0",run_as_process:1,sdk_instant_resume:1}}} satisfies RokuConfig;\n`,
  );
  write(
    resolve(outputDirectory, "tsconfig.json"),
    JSON.stringify(
      {
        extends: "@roku-sdk/rsg-ts/tsconfig.json",
        compilerOptions: {
          lib: ["ES2022", "DOM"],
          types: ["node", "react", "@roku-sdk/interfaces/global"],
          rootDir: root,
          composite: false,
          incremental: false,
          noEmit: true,
          strict: true,
          jsx: "react-jsx",
          jsxImportSource: "@roku-sdk/solid",
        },
        include: ["src", "roku-config.ts"],
      },
      null,
      2,
    ),
  );
  write(
    resolve(outputDirectory, "build-profile.json"),
    JSON.stringify(
      {
        schema: "react-native-roku-profile/v1",
        profile: compilation.name,
      },
      null,
      2,
    ) + "\n",
  );
  return {
    config,
    directory: outputDirectory,
    generated,
    native,
    profile: compilation.name,
    fonts: preparedFonts,
    imageAssets: Object.fromEntries(imageAssets),
    imageDirectory,
    ...(refreshGraph ? { refreshGraph } : {}),
  };
}
export async function buildRokuProject(root = process.cwd(), { profile = "production" } = {}) {
  const result = await prepareRokuProject(root, { profile });
  write(
    resolve(result.directory, "package.json"),
    JSON.stringify({
      name: "roku-generated-host",
      private: true,
      type: "module",
    }),
  );
  const command = resolve(root, "node_modules/@roku-sdk/tooling/bin/rk.mjs");
  const built = spawnSync(process.execPath, [command, "build", "--debug", "--local"], {
    cwd: result.directory,
    stdio: "inherit",
  });
  if (built.status !== 0) throw Error(`Roku SDK build exited ${built.status}`);
  const bundle = resolve(result.directory, "dist/sdk/bundle"),
    zip = resolve(
      root,
      "dist",
      profile === "development" ? "roku-app-development.zip" : "roku-app.zip",
    );
  copyFileSync(
    resolve(result.directory, "build-profile.json"),
    resolve(bundle, "build-profile.json"),
  );
  mkdirSync(dirname(zip), { recursive: true });
  rmSync(zip, { force: true });
  const zipped = spawnSync("zip", ["-q", "-r", zip, "."], {
    cwd: bundle,
    stdio: "inherit",
  });
  if (zipped.status !== 0) throw Error("Roku ZIP creation failed");
  return { bundle, zip, profile: result.profile };
}
export function doctorRokuProject(root = process.cwd()) {
  const checks = doctorEnvironment(root).checks;
  let config;
  try {
    config = readRokuConfig(root);
    checks.push({ name: "configuration and entry", status: "passed" });
  } catch (error) {
    checks.push({ name: "configuration and entry", status: "failed", message: error.message });
  }
  const check = (name, work) => {
    try {
      work();
      checks.push({ name, status: "passed" });
    } catch (error) {
      checks.push({ name, status: "failed", message: error.message });
    }
  };
  if (config)
    check("packaged fonts", () => {
      for (const specifier of Object.values(config.fonts.assets))
        if (!existsSync(resolveProjectFont(root, specifier)))
          throw Error("A font asset is missing");
    });
  if (config?.bundler === "metro")
    for (const [name, version] of Object.entries(toolchain.optionalPackages.metro))
      check(`Metro: ${name}`, () => {
        const expected = version.startsWith("npm:")
          ? version.slice(version.lastIndexOf("@") + 1)
          : version;
        if (installedPackage(root, name).version !== expected)
          throw Error(`Install the reviewed optional Metro tool cohort: ${name}@${version}`);
      });
  return {
    status: checks.every((value) => value.status === "passed") ? "passed" : "failed",
    checks,
    deviceQualified: false,
    qualification: "Host/build readiness only; physical Roku qualification remains pending",
  };
}

export async function buildRokuPreview(
  root = process.cwd(),
  { outputDirectory = resolve(root, ".roku/preview"), profile = "development", refresh } = {},
) {
  const result = await prepareRokuProject(root, {
    outputDirectory: resolve(outputDirectory, "project"),
    profile,
    refresh,
  });
  const { config, generated } = result;
  for (const name of Object.keys(result.imageAssets)) {
    const target = resolve(outputDirectory, "assets", name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(result.imageDirectory, "assets", name), target);
  }
  const cornerMasks = [0, 1, 2, 3].map((index) => `surfaces/corner-${index}.png`);
  mkdirSync(resolve(outputDirectory, "surfaces"), { recursive: true });
  for (const path of cornerMasks)
    copyFileSync(resolve(generated, path), resolve(outputDirectory, path));
  const graphics = { effects: true, composedMasks: true };
  const fonts = {};
  for (const [index, [family, path]] of Object.entries(result.fonts.assets).entries()) {
    const target = resolve(outputDirectory, `fonts/font-${index}.ttf`);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(path, target);
    fonts[family] = `/fonts/font-${index}.ttf`;
  }
  let bootstrap = "";
  if (refresh) {
    const runtime = writeRokuRefreshBootstrap({
      root,
      ...refresh,
      outfile: resolve(outputDirectory, "refresh-bootstrap.mjs"),
    });
    bootstrap = `import ${JSON.stringify(runtime)};`;
    const identity = digest(
      JSON.stringify({
        config: developmentConfigFiles.map((name) => [
          name,
          existsSync(resolve(root, name)) ? digest(readFileSync(resolve(root, name))) : null,
        ]),
        runtime: runtimeInputs(),
        fonts: Object.entries(result.fonts.assets).map(([name, path]) => [
          name,
          digest(readFileSync(path)),
        ]),
        images: Object.keys(result.imageAssets)
          .sort()
          .map((name) => [
            name,
            digest(readFileSync(resolve(result.imageDirectory, "assets", name))),
          ]),
      }),
    );
    refresh.session.stage({
      generation: refresh.generation,
      graph: result.refreshGraph,
      identity,
      outputDirectory,
    });
  }
  const source = `${bootstrap}import {CanvasSceneGraph,createCanvasTextMetrics,createCanvasTextRaster,createCanvasTextEntry} from "react-native-roku/preview";import {NativeSystemState} from "react-native-roku/system";import {mountApplication} from ${JSON.stringify(resolve(generated, "application.mjs"))};
 const canvas=document.querySelector('canvas'),scene=new CanvasSceneGraph(canvas),text=createCanvasTextMetrics(scene,{defaultFamily:${JSON.stringify(config.fonts.defaultFamily)},assets:${JSON.stringify(fonts)},families:${JSON.stringify(result.fonts.families)}}),system=new NativeSystemState({appState:'active',reduceMotion:false,screenReader:false,colorScheme:'dark'});const errors=[];
 const keyboard=createCanvasTextEntry();const app=mountApplication({scene,text,system,textEntry:keyboard,textRaster:createCanvasTextRaster(scene,text),graphics:${JSON.stringify(graphics)},viewport:${JSON.stringify(config.viewport)},onError(error){errors.push(error.message);document.querySelector('#status').textContent=error.message;}});
 globalThis.__RNR_ROKU_REFRESH__?.setApplication(app,()=>{document.querySelector('#status').textContent='Host preview · focus observations are fixtures · device qualification pending';});
 const map={ArrowUp:'up',ArrowDown:'down',ArrowLeft:'left',ArrowRight:'right',Enter:'select',Escape:'back'},keys=[];for(const type of ['keydown','keyup']){const handler=event=>{const key=map[event.key];if(key&&!stopped&&!keyboard.isOpen()){event.preventDefault();app.remote({key,phase:type==='keyup'?'up':event.repeat?'repeat':'down'});}};keys.push([type,handler]);document.addEventListener(type,handler);}
 let stopped=false,frame,seen=-1;function observe(){if(stopped)return;const id=scene.focusRequests.at(-1);if(id&&seen!==scene.focusRequestSequence){const node=[...scene.nodes.values()].find(value=>value.fields.id===id);if(node){seen=scene.focusRequestSequence;scene.emit(node,'focusedChild',id);}}frame=requestAnimationFrame(observe);}observe();
 app.whenCommitted().then(()=>document.querySelector('#status').textContent='Host preview · focus observations are fixtures · device qualification pending',error=>document.querySelector('#status').textContent=error.message);
 let closing;const stop=()=>{if(closing)return closing;stopped=true;cancelAnimationFrame(frame);for(const [type,handler]of keys)document.removeEventListener(type,handler);window.removeEventListener('pagehide',stop);globalThis.__RNR_ROKU_REFRESH__?.dispose();closing=Promise.resolve(app.dispose()).finally(()=>{keyboard.dispose();text.dispose();scene.dispose();});return closing;};
 window.__ROKU_DEV__={snapshot:()=>({texts:[...scene.nodes.values()].map(node=>node.fields.text).filter(Boolean),nodes:scene.nodes.size,listeners:scene.listenerCount,errors,disposed:stopped,refresh:globalThis.__RNR_ROKU_REFRESH__?.snapshot()}),remote:event=>stopped||keyboard.isOpen()?false:app.remote(event),dispose:stop};
 window.addEventListener('pagehide',stop,{once:true});`;
  await build({
    absWorkingDir: root,
    stdin: {
      contents: source,
      resolveDir: root,
      sourcefile: "roku-preview-entry.ts",
    },
    outfile: resolve(outputDirectory, "preview.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    sourcemap: true,
    define: rokuBuildProfile(profile).defines,
  });
  write(
    resolve(outputDirectory, "index.html"),
    `<!doctype html><html><meta charset="utf-8"><title>Roku development preview</title><body style="margin:0;background:#101014;color:white;font:16px system-ui"><p id="status">Loading…</p><canvas tabindex="0" width="${config.viewport.width}" height="${config.viewport.height}" style="width:100%;height:auto"></canvas><script type="module" src="/preview.js"></script></body></html>`,
  );
  return outputDirectory;
}
export async function createRokuProjectDevServer(
  root = process.cwd(),
  { profile = "development", port: requestedPort, onBuild = () => {} } = {},
) {
  rokuBuildProfile(profile);
  const { createRokuDevServer } = await import("./dev.mjs");
  const config = readRokuConfig(root);
  const port = requestedPort ?? Number(process.env.ROKU_DEV_PORT ?? config.dev?.port ?? 9389);
  if (!Number.isInteger(port) || (port < 1024 && requestedPort !== 0) || port < 0 || port > 65535)
    throw Error("ROKU_DEV_PORT must be 1024–65535");
  const workspace = createRokuDevWorkspace(resolve(root, ".roku/dev"), { label: config.name });
  const session = createRokuMetroRefreshSession({
    root,
    directory: resolve(workspace.directory, "frontend"),
  });
  const server = await createRokuDevServer({
    port,
    watchPaths: [
      resolve(root, "src"),
      ...developmentConfigFiles.map((name) => resolve(root, name)),
    ],
    build: async ({ generation }) => {
      session.discard(generation);
      const refresh =
        profile === "development" && readRokuConfig(root).bundler === "metro"
          ? { session, generation }
          : undefined;
      const directory = await buildRokuPreview(root, {
        outputDirectory: workspace.generation(generation),
        profile,
        refresh,
      });
      return { directory, ...(refresh ? { refresh: session.plan(generation) } : {}) };
    },
    onBuild: (state) => {
      if (state.state === "ready") {
        if (session.plan(state.generation)) session.publish(state.generation);
        workspace.publish(state.generation);
      }
      onBuild(state);
    },
  }).catch((error) => {
    workspace.dispose();
    session.dispose();
    throw error;
  });
  const close = server.close;
  return {
    ...server,
    workspaceDirectory: workspace.directory,
    async close() {
      await close();
      session.dispose();
      workspace.dispose();
    },
  };
}
export async function devRokuProject(root = process.cwd(), { profile = "development" } = {}) {
  const server = await createRokuProjectDevServer(root, {
    profile,
    onBuild: (state) => console.log(JSON.stringify(state)),
  });
  console.log(`Roku development preview: ${server.url}`);
  await new Promise((resolve) => {
    const stop = () => {
      void server.close().then(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function rokuMainSource(scene) {
  return `sub Main()\n screen=CreateObject("roSGScreen")\n port=CreateObject("roMessagePort")\n screen.setMessagePort(port)\n scene=screen.CreateScene("${scene}")\n scene.observeField("exitRequested",port)\n screen.show()\n while true\n  message=wait(0,port)\n  if type(message)="roSGScreenEvent"\n   if message.isScreenClosed() then return\n  else if type(message)="roSGNodeEvent"\n   if message.getField()="exitRequested" and message.getData()=true then return\n  end if\n end while\nend sub\n`;
}

export function createRokuSdkConfiguration(root, preBuild) {
  const config = readRokuConfig(root);
  return {
    outDir: "dist/sdk",
    pipeline: { build: { preBuild } },
    app: {
      entryPoint: "src/generated/entry.ts",
      images: { convertToWebp: false, generateHd: false },
      logger: { baseLogLevel: "INFO", currentLogLevel: "INFO" },
      manifestEntries: {
        title: config.displayName,
        major_version: 0,
        minor_version: 1,
        build_version: 0,
        ui_resolutions: "fhd",
        rsg_version: "2.0",
        run_as_process: 1,
        sdk_instant_resume: 1,
        splash_color: `0x${config.background.slice(1)}FF`,
        splash_min_time: 0,
      },
    },
  };
}
