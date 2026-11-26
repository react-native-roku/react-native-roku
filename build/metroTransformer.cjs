const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { resolve } = require("node:path");
const { runtimeInputs, resolveRuntime } = require("./index.mjs");
const { prepareHermesYoga } = require("./yoga.mjs");
const { prepareIntlDataModules } = require("./intl.mjs");
const {
  prepareNativewindInterop,
  prepareNativewindPreferences,
  prepareNativewindInputState,
} = require("./nativewind.mjs");
const { prepareReactEntry } = require("./reactProfile.cjs");
const { createRokuImageAssets } = require("./assets.cjs");

/** Compose with the application's Babel transformer; never replace its Babel policy. */
exports.withRokuBabelTransformer = function withRokuBabelTransformer(
  upstream,
  {
    root = process.cwd(),
    generatedDirectory,
    plugins = [],
    imageAssets,
    preparedSourcesPath,
    fastRefresh,
  } = {},
) {
  const brand = Symbol.for("react-native-roku.metro-transformer");
  const inherited = upstream?.[brand];
  if (inherited) {
    upstream = inherited.upstream ?? inherited;
    plugins = [...plugins, ...(inherited.plugins ?? [])];
    generatedDirectory ??= inherited.generatedDirectory;
    imageAssets ??= inherited.imageAssets;
    preparedSourcesPath ??= inherited.preparedSourcesPath;
    fastRefresh ??= inherited.fastRefresh;
  }
  if (typeof upstream?.transform !== "function")
    throw new TypeError("A Roku Babel transformer requires an upstream transform function");
  const require = createRequire(resolve(root, "package.json"));
  const platformRequire = createRequire(__filename);
  const syntaxPlugins = [...new Set(plugins.map((plugin) => require.resolve(plugin)))];
  const images = imageAssets ? createRokuImageAssets({ ...imageAssets, root }) : null;
  const preparedBytes = preparedSourcesPath ? readFileSync(preparedSourcesPath) : null;
  const preparedSources = preparedBytes ? JSON.parse(preparedBytes) : {};
  const transformer = {
    ...upstream,
    transform(args) {
      if (args.options.platform !== "roku") return upstream.transform.call(upstream, args);
      const path = resolve(args.options.projectRoot ?? root, args.filename);
      let src = prepareReactEntry(args.src, path, args.options.dev === true);
      const prepared = preparedSources[path];
      if (prepared) {
        if (createHash("sha256").update(args.src).digest("hex") !== prepared.sha256)
          throw Error(`Roku image source changed during preparation: ${path}`);
        src = prepared.contents;
      }
      if (/@formatjs[/\\]intl-collator[/\\](?:index|polyfill(?:-force)?)\.js$/.test(path))
        src = prepareIntlDataModules(path, generatedDirectory, { source: src }).contents;
      else if (
        /yoga-layout-prebuilt[/\\]yoga-layout[/\\]build[/\\]Release[/\\]nbind\.js$/.test(path)
      )
        // Metro hashes args.src. Rereading this file could cache newer bytes under
        // the hash of an older snapshot during an editor save.
        src = prepareHermesYoga(path, { source: src }).contents;
      else if (/react-native-css-interop[/\\]dist[/\\]runtime[/\\]native[/\\]api\.js$/.test(path))
        src = prepareNativewindInterop(src, resolveRuntime("interop/nativewind"));
      else if (
        /react-native-css-interop[/\\]dist[/\\]runtime[/\\]native[/\\]native-interop\.js$/.test(
          path,
        )
      )
        src = prepareNativewindInputState(src);
      else if (
        /react-native-css-interop[/\\]dist[/\\]runtime[/\\]native[/\\]appearance-observables\.js$/.test(
          path,
        )
      )
        src = prepareNativewindPreferences(src);
      const transform = (src) =>
        upstream.transform.call(
          upstream,
          src === args.src && !syntaxPlugins.length && !(fastRefresh && args.options.dev)
            ? args
            : {
                ...args,
                src,
                ...(fastRefresh && args.options.dev
                  ? { options: { ...args.options, hot: true } }
                  : {}),
                ...(syntaxPlugins.length
                  ? { plugins: [...syntaxPlugins, ...(args.plugins ?? [])] }
                  : {}),
              },
        );
      return images && src.includes("data:image/")
        ? images.prepareEmbeddedSource(path, src, { inline: true }).then(transform)
        : transform(src);
    },
    getCacheKey(...args) {
      const hash = createHash("sha256");
      hash.update(upstream.getCacheKey?.apply(upstream, args) ?? "");
      hash.update(JSON.stringify(runtimeInputs()));
      hash.update(process.versions.node);
      if (preparedBytes) {
        if (!readFileSync(preparedSourcesPath).equals(preparedBytes))
          throw Error("Roku prepared image snapshot changed during compilation");
        hash.update(preparedBytes);
      }
      for (const plugin of syntaxPlugins) hash.update(plugin).update(readFileSync(plugin));
      hash.update(
        JSON.stringify({
          root: resolve(root),
          generatedDirectory: generatedDirectory ? resolve(generatedDirectory) : null,
          imageAssets: imageAssets ?? null,
          preparedSourcesPath: preparedSourcesPath ?? null,
          fastRefresh: fastRefresh ?? false,
        }),
      );
      // Yoga's finite signature discovery also executes these trusted build-time
      // inputs. Their changes must invalidate a previously prepared binding.
      for (const name of ["entry-common.js", "YGEnums.js"]) {
        const specifier = "yoga-layout-prebuilt/yoga-layout/dist/" + name;
        const paths = new Set([platformRequire.resolve(specifier)]);
        try {
          paths.add(require.resolve(specifier));
        } catch (error) {
          if (error.code !== "MODULE_NOT_FOUND") throw error;
        }
        for (const path of paths) hash.update(readFileSync(path));
      }
      return hash.digest("hex");
    },
  };
  Object.defineProperty(transformer, brand, {
    value: {
      upstream,
      plugins: syntaxPlugins,
      generatedDirectory,
      imageAssets,
      preparedSourcesPath,
      fastRefresh,
    },
  });
  return transformer;
};
