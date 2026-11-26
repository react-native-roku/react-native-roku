import type { BuildOptions, BuildResult } from "esbuild";
import type { RokuBuildProfile } from "./environment.mjs";
export { createRokuMetroRefreshSession, writeRokuRefreshBootstrap } from "./metroRefresh.mjs";
export type {
  RokuRefreshPlan,
  RokuMetroRefreshGraph,
  RokuMetroRefreshSession,
  RokuMetroRefreshContext,
} from "./metroRefresh.mjs";
export declare function buildRokuMetroModules(options: {
  root?: string;
  entry: string;
  outfile: string;
  profile?: RokuBuildProfile;
  configPath?: string;
  configuration?: object;
  workDirectory?: string;
  exports?: readonly string[];
  maxModuleBytes?: number;
  imageAssets?: Omit<import("./assets.cjs").RokuImageAssetsOptions, "root" | "reset">;
  refresh?: import("./metroRefresh.mjs").RokuMetroRefreshContext;
}): Promise<{
  outfile: string;
  modules: number;
  entryModuleId: number | string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  profile: RokuBuildProfile;
  bundler: "metro";
  bundle: string;
  bundleSha256: string;
  sourceMap: string;
  sources: string[];
  assets: Array<{
    files: string[];
    scales: number[];
    name: string;
    type: string;
    hash: string;
    width?: number;
    height?: number;
    [property: string]: unknown;
  }>;
  imageAssets?: Record<string, import("./assets.cjs").RokuImageAssetRecord>;
  imagePreparationPasses?: number;
  refreshGraph?: import("./metroRefresh.mjs").RokuMetroRefreshGraph;
  metafile: import("esbuild").Metafile;
  intl: Array<{ path: string; sha256: string; files: string[] }>;
}>;
export declare function buildRokuReactModules(
  configuration: BuildOptions,
  options?: { partition?: boolean; maxModuleBytes?: number },
): Promise<BuildResult<{ metafile: true }>>;
