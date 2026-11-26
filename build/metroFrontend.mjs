import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { rokuBuildProfile, installedPackage, toolchain } from "./environment.mjs";
import { prepareIntlDataModules } from "./intl.mjs";
import { writeMetroModules } from "./metroModules.mjs";
import { withRoku } from "./metro.cjs";
import { createMetroMetadata } from "./metroMetadata.mjs";
import { createRokuImageAssets } from "./assets.cjs";

const platformRequire = createRequire(import.meta.url);

/** Finite optional frontend; applications retain their Metro/Babel configuration
 * and export ordinary mount functions. SDK/Solid compilation remains separate. */
export async function buildRokuMetroModules({
  root = process.cwd(),
  entry,
  outfile,
  profile = "production",
  configPath,
  configuration,
  workDirectory,
  exports: names = ["mountApplication"],
  maxModuleBytes = 2 * 1024 * 1024,
  imageAssets,
  refresh,
}) {
  root = resolve(root);
  if (typeof entry !== "string" || typeof outfile !== "string")
    throw Error("A Roku Metro frontend needs an entry and outfile");
  outfile = resolve(root, outfile);
  workDirectory = resolve(root, workDirectory ?? resolve(dirname(outfile), ".metro"));
  const compilation = rokuBuildProfile(profile);
  if (
    refresh &&
    (!compilation.development || typeof refresh.session?.createModuleIdFactory !== "function")
  )
    throw Error("Roku refresh requires a development profile and a refresh session");
  const require = createRequire(resolve(root, "package.json"));
  for (const [name, version] of Object.entries(toolchain.optionalPackages.metro)) {
    const expected = version.startsWith("npm:")
      ? version.slice(version.lastIndexOf("@") + 1)
      : version;
    let actual;
    try {
      actual = installedPackage(root, name).version;
    } catch {
      throw Error(
        `Install the optional Metro tool cohort before using the Metro frontend: ${name}@${version}`,
      );
    }
    if (actual !== expected)
      throw Error(`Review the Metro tool cohort: expected ${name}@${expected}, found ${actual}`);
  }
  const Metro = require("metro");
  const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");
  if (configuration && configPath) throw Error("Choose a Metro configuration object or configPath");
  const config = configuration
    ? mergeConfig(getDefaultConfig(root), configuration)
    : await Metro.loadConfig(
        { cwd: root, ...(configPath ? { config: resolve(root, configPath) } : {}) },
        getDefaultConfig(root),
      );
  const generatedDirectory = resolve(workDirectory, "dependencies");
  const images = imageAssets ? createRokuImageAssets({ ...imageAssets, root, reset: true }) : null;
  const imageConfiguration = images?.metroConfiguration();
  // The file map must see extracted data before Metro starts. Cache hits still
  // refer to these content-addressed files, so prepare every pinned entry that
  // can carry collation tables without pruning or executing dependency source.
  const intl = ["index.js", "polyfill.js", "polyfill-force.js"].map((name) => {
    const path = platformRequire.resolve(
      "@formatjs/intl-collator" + (name === "index.js" ? "" : "/" + name),
    );
    const prepared = prepareIntlDataModules(path, generatedDirectory);
    return {
      path,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      files: prepared.files,
    };
  });
  mkdirSync(workDirectory, { recursive: true });
  const upstream = require.resolve(config.transformer.babelTransformerPath);
  const preparedSources = {};
  let bundle,
    metadata,
    raw,
    imagePreparationPasses = 0;
  for (let attempt = 0; attempt < (images ? 3 : 1); attempt++) {
    const phase = images ? resolve(workDirectory, `image-pass-${attempt}`) : workDirectory;
    mkdirSync(phase, { recursive: true });
    const prepared = JSON.stringify(preparedSources);
    const identity = createHash("sha256").update(prepared).digest("hex").slice(0, 24);
    const preparedSourcesPath = images ? resolve(phase, `prepared-${identity}.json`) : undefined;
    if (preparedSourcesPath) writeFileSync(preparedSourcesPath, prepared + "\n");
    const transformer = resolve(phase, `transformer-${identity}.cjs`);
    writeFileSync(
      transformer,
      `const {withRokuBabelTransformer}=require(${JSON.stringify(platformRequire.resolve("react-native-roku/metro"))});module.exports=withRokuBabelTransformer(require(${JSON.stringify(upstream)}),${JSON.stringify({ root, generatedDirectory, imageAssets: images ? false : undefined, preparedSourcesPath, fastRefresh: !!refresh, plugins: [require.resolve("@babel/plugin-transform-class-static-block")] })});\n`,
    );
    const effective = withRoku(
      mergeConfig(config, {
        watchFolders: [
          ...new Set([
            ...(config.watchFolders ?? []),
            root,
            resolve(workDirectory),
            ...(imageAssets ? [resolve(root, imageAssets.generatedDirectory)] : []),
          ]),
        ],
        resolver: {
          nodeModulesPaths: [
            ...new Set([
              ...(config.resolver.nodeModulesPaths ?? []),
              resolve(root, "node_modules"),
            ]),
          ],
        },
        transformer: {
          babelTransformerPath: transformer,
          ...(imageConfiguration
            ? {
                assetRegistryPath: imageConfiguration.assetRegistryPath,
                assetPlugins: [
                  ...(config.transformer.assetPlugins ?? []),
                  ...imageConfiguration.assetPlugins,
                ],
              }
            : {}),
        },
      }),
      { root },
    );
    if (refresh)
      effective.serializer.createModuleIdFactory = refresh.session.createModuleIdFactory(
        effective.serializer.createModuleIdFactory.bind(effective.serializer),
      );
    metadata = createMetroMetadata(root, effective.serializer, refresh);
    effective.serializer = metadata.serializer;
    raw = resolve(phase, "metro.bundle.js");
    bundle = await Metro.runBuild(effective, {
      entry: relative(effective.projectRoot, resolve(root, entry)),
      platform: "roku",
      dev: compilation.development,
      minify: false,
      bundleOut: raw,
      sourceMap: true,
      sourceMapOut: raw + ".map",
      sourceMapUrl: "metro.bundle.js.map",
      assets: true,
    });
    if (!Array.isArray(bundle.assets)) throw Error("Review the Metro asset inventory contract");
    if (!images) break;
    imagePreparationPasses++;
    let added = false;
    const owned = resolve(root, imageAssets.generatedDirectory, "embedded-images") + sep;
    for (const { path, source } of metadata.embeddedSources()) {
      if (path.startsWith(owned)) continue;
      const contents = await images.prepareEmbeddedSource(path, source);
      if (contents === source) continue;
      const sha256 = createHash("sha256").update(source).digest("hex");
      const old = preparedSources[path];
      if (old && old.sha256 !== sha256)
        throw Error(`Roku image source changed during preparation: ${path}`);
      if (!old || old.contents !== contents) {
        preparedSources[path] = { sha256, contents };
        added = true;
      }
    }
    if (!added) {
      await images.restoreMetroAssets(bundle.assets);
      break;
    }
    if (attempt === 2) throw Error("The Metro image dependency graph did not settle");
  }
  let refreshMap;
  if (refresh) {
    const path = resolve(workDirectory, "refresh-source-map.json");
    writeFileSync(path, bundle.map);
    refreshMap = {
      path,
      sha256: createHash("sha256").update(bundle.map).digest("hex"),
      url: pathToFileURL(raw + ".map").href,
    };
  }
  const result = writeMetroModules({
    code: bundle.code,
    map: JSON.parse(bundle.map),
    mapUrl: pathToFileURL(raw + ".map").href,
    outfile: resolve(root, outfile),
    exports: names,
    profile: compilation.name,
    metadata,
    maxModuleBytes,
    ...(refresh
      ? { refresh: { sessionId: refresh.session.id, generation: refresh.generation }, refreshMap }
      : {}),
  });
  result.metafile.outputs[relative(root, outfile).split("\\").join("/")].entryPoint = relative(
    root,
    resolve(root, entry),
  )
    .split("\\")
    .join("/");
  const record = {
    ...result,
    profile: compilation.name,
    bundler: "metro",
    bundle: raw,
    bundleSha256: createHash("sha256").update(bundle.code).digest("hex"),
    intl,
    sourceMap: raw + ".map",
    sources: JSON.parse(bundle.map).sources,
    assets: bundle.assets,
    ...(images
      ? { imageAssets: Object.fromEntries(images.inventory()), imagePreparationPasses }
      : {}),
  };
  writeFileSync(resolve(workDirectory, "frontend.json"), JSON.stringify(record, null, 2) + "\n");
  return record;
}
