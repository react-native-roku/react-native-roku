import { resolveRokuRelative } from "./resolution.mjs";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveAdapter, resolveRuntime } from "./index.mjs";
import { prepareHermesYoga } from "./yoga.mjs";
import { prepareIntlDataModules } from "./intl.mjs";
import {
  nativewindLeaf,
  prepareNativewindInterop,
  prepareNativewindPreferences,
  prepareNativewindInputState,
} from "./nativewind.mjs";

/** Frontend-only platform resolution. Keep SDK anchor code in its own SDK stage. */
export function rokuPlugin({ root = process.cwd(), generatedDirectory } = {}) {
  const require = createRequire(resolve(root, "package.json"));
  return {
    name: "react-native-roku",
    setup(builder) {
      const builtinResolution = {};
      builder.initialOptions.mainFields ??= ["module", "main"];
      builder.initialOptions.conditions ??= ["roku", "import", "default"];
      builder.onLoad(
        { filter: /@formatjs[/\\]intl-collator[/\\](?:index|polyfill(?:-force)?)\.js$/ },
        (args) => ({
          loader: "js",
          contents: prepareIntlDataModules(args.path, generatedDirectory).contents,
          resolveDir: resolve(args.path, ".."),
        }),
      );
      builder.onLoad({ filter: /@rn-primitives[/\\]portal[/\\]dist[/\\]index\.mjs$/ }, (args) => ({
        loader: "jsx",
        contents: readFileSync(args.path, "utf8"),
      }));
      builder.onLoad(
        {
          filter: /react-native-css-interop[/\\]dist[/\\]runtime[/\\]native[/\\]api\.js$/,
        },
        (args) => ({
          loader: "js",
          contents: prepareNativewindInterop(
            readFileSync(args.path, "utf8"),
            resolveRuntime("interop/nativewind"),
          ),
        }),
      );
      builder.onLoad(
        {
          filter:
            /react-native-css-interop[/\\]dist[/\\]runtime[/\\]native[/\\]native-interop\.js$/,
        },
        (args) => ({
          loader: "js",
          contents: prepareNativewindInputState(readFileSync(args.path, "utf8")),
        }),
      );
      builder.onLoad(
        {
          filter:
            /react-native-css-interop[/\\]dist[/\\]runtime[/\\]native[/\\]appearance-observables\.js$/,
        },
        (args) => ({
          loader: "js",
          contents: prepareNativewindPreferences(readFileSync(args.path, "utf8")),
        }),
      );
      builder.onLoad(
        {
          filter: /yoga-layout-prebuilt[/\\]yoga-layout[/\\]build[/\\]Release[/\\]nbind\.js$/,
        },
        (args) => ({
          loader: "js",
          contents: prepareHermesYoga(args.path).contents,
        }),
      );
      builder.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData === builtinResolution) return;
        const adapter = resolveAdapter(args.path);
        if (adapter) return { path: adapter };
        if (args.path === "react" || args.path.startsWith("react/"))
          return { path: require.resolve(args.path) };
        const leaf = nativewindLeaf(args.path, args.importer, require);
        if (leaf) return { path: leaf };
        if (args.path.startsWith("react-native/"))
          return {
            errors: [
              {
                text: `Private React Native import needs an explicit Roku adapter: ${args.path} (from ${args.importer})`,
              },
            ],
          };
        if (args.path.startsWith("@roku-sdk/"))
          return {
            errors: [
              {
                text: `SDK mechanics belong in the bootstrap, not the React frontend: ${args.path}`,
              },
            ],
          };
        if (args.importer) {
          const selected = resolveRokuRelative(args.importer, args.path);
          if (selected) {
            // Preserve package sideEffects metadata when selecting a source
            // variant. Returning only a path retains every re-exported icon.
            const resolved = await builder.resolve(selected, {
              kind: args.kind,
              resolveDir: args.resolveDir,
              pluginData: builtinResolution,
            });
            return { ...resolved, pluginData: args.pluginData };
          }
        }
        return undefined;
      });
    },
  };
}
