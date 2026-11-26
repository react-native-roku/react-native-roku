import { withRokuBabelTransformer } from "react-native-roku/metro";
import { buildRokuMetroModules } from "react-native-roku/build/frontend";
import type { RokuProjectConfig } from "react-native-roku/build/project";
import { createRokuImageAssets } from "react-native-roku/build/assets";

export async function configureMetroFrontend(root: string) {
  const config: RokuProjectConfig = { name: "App", entry: "src/App.tsx", bundler: "metro" };
  const result = await buildRokuMetroModules({
    root,
    entry: "entry.ts",
    outfile: "application.mjs",
    profile: "development",
    exports: ["mountApplication"],
    configuration: { resolver: {} },
    imageAssets: { generatedDirectory: "generated/images" },
  });
  const bytes: number = result.files[0].bytes;
  const bundler: "metro" = result.bundler;
  const assetFiles: string[][] = result.assets.map((asset) => asset.files);
  const images = createRokuImageAssets({ root, generatedDirectory: "generated/images" });
  const packaged: Map<string, { source: string; width: number; height: number }> =
    images.inventory();
  // @ts-expect-error Build profiles are the same bounded contract as other builders.
  buildRokuMetroModules({ root, entry: "entry.ts", outfile: "app.mjs", profile: "unknown" });
  const imageTransformer = withRokuBabelTransformer(
    { transform: (input: { src: string }) => ({ code: input.src }) },
    { root, imageAssets: { generatedDirectory: "generated/images" } },
  );
  const imageResult: { code: string } = await imageTransformer.transform({ src: "fixture" });
  return { config, bytes, bundler, assetFiles, packaged, imageResult };
}

/** Preserve the consumer transformer's real argument and result contracts. */
export function configureMetroTransformer() {
  const transformer = withRokuBabelTransformer({
    transform(input: {
      filename: string;
      src: string;
      options: { platform: string; dev: boolean };
    }) {
      return Promise.resolve({ ast: input.src, metadata: { development: input.options.dev } });
    },
    getCacheKey(configuration: string) {
      return configuration;
    },
    supportsCustomFeature: true,
  });
  const key: string = transformer.getCacheKey("configured");
  const result: Promise<{ ast: string; metadata: { development: boolean } }> =
    transformer.transform({
      filename: "App.tsx",
      src: "source",
      options: { platform: "roku", dev: false },
    });
  const feature: boolean = transformer.supportsCustomFeature;
  // @ts-expect-error The upstream transform still requires its development option.
  transformer.transform({ filename: "App.tsx", src: "source", options: { platform: "roku" } });
  // @ts-expect-error Preserve upstream cache-key arguments.
  transformer.getCacheKey(123);
  // @ts-expect-error A transformer must implement transform.
  withRokuBabelTransformer({
    getCacheKey() {
      return "key";
    },
  });
  return { key, result, feature };
}
