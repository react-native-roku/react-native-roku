import type { Plugin } from "esbuild";

export interface RokuImageAssetsOptions {
  root?: string;
  generatedDirectory: string;
  /** Target raster density. The current logical-pixel host defaults to 1. */
  scale?: number;
  /** Clear owned metadata before a new build. Physical assets remain reusable. */
  reset?: boolean;
}
export interface RokuPackagedImage {
  uri: string;
  width: number;
  height: number;
}
export interface RokuImageAssetRecord {
  source: string;
  width: number;
  height: number;
}
export interface RokuMetroRasterAsset {
  files: readonly string[];
  scales: readonly number[];
  type: string;
  name?: string;
  width?: number;
  height?: number;
  rokuSource?: RokuPackagedImage;
}
export declare function createRokuImageAssets(options: RokuImageAssetsOptions): {
  packageImage(content: Uint8Array, source: string, extension: string): Promise<RokuPackagedImage>;
  prepareEmbeddedSource(
    path: string,
    source: string,
    options?: { inline?: boolean },
  ): Promise<string>;
  inventory(usedSources?: ReadonlySet<string>): Map<string, RokuImageAssetRecord>;
  restoreMetroAssets(descriptors: readonly RokuMetroRasterAsset[]): Promise<void>;
  metroConfiguration(): { assetPlugins: string[]; assetRegistryPath: string };
  writeSdkModule(
    path: string,
    usedSources?: ReadonlySet<string>,
  ): Map<string, RokuImageAssetRecord>;
  /** Standalone esbuild compilation. Custom Babel owners call prepareEmbeddedSource themselves. */
  esbuildPlugin(): Plugin;
};
export declare function packageRokuMetroAsset<T extends RokuMetroRasterAsset>(
  descriptor: T,
  options: RokuImageAssetsOptions,
): Promise<T & { rokuSource: RokuPackagedImage }>;
