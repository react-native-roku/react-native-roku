import type { FontFamilyGroups } from "../src/layout/fontFaces.mjs";
import type { RokuBuildProfile } from "./environment.mjs";
export interface RokuProjectConfig {
  name: string;
  entry: string;
  displayName?: string;
  entryMode?: "component" | "registry" | "mount";
  bundler?: "esbuild" | "metro";
  reactCompiler?: boolean;
  storageNamespace?: string;
  mountOptions?: Record<string, unknown>;
  background?: string;
  fonts?: {
    defaultFamily: string;
    assets: Record<string, string>;
    families?: FontFamilyGroups;
    variants?: readonly "tabular-nums"[];
  };
  viewport?: { width: number; height: number };
  dev?: { port: number };
}
export declare function readRokuConfig(root?: string): RokuProjectConfig & {
  fonts: NonNullable<RokuProjectConfig["fonts"]>;
  viewport: { width: number; height: number };
  background: string;
  displayName: string;
  bundler: "esbuild" | "metro";
};
export declare function resolveProjectFont(root: string, specifier: string): string;
export declare function generateSdkEntry(options: {
  directory: string;
  name?: string;
  displayName?: string;
  mountModule?: string;
  mountExport?: string;
  mountOptions?: Record<string, unknown>;
  fontsModule?: string;
  defaultFamily?: string;
  fontFamilies?: FontFamilyGroups;
  componentsModule?: string;
  viewport?: { width: number; height: number };
  background?: string;
  storageNamespace?: string;
  svgAtlasModule?: string;
  cornerMasksModule?: string;
  staticAssetsModule?: string;
  buildIdentity?: {
    inputFingerprint?: string;
    runtimeSha256?: string;
    frontendGraphSha256?: string;
  };
}): { anchor: string; scene: string; entry: string; mainSource: string };
export declare function prepareRokuProject(
  root?: string,
  options?: {
    outputDirectory?: string;
    frontend?: boolean;
    profile?: RokuBuildProfile;
    refresh?: import("./metroRefresh.mjs").RokuMetroRefreshContext;
  },
): Promise<{
  config: ReturnType<typeof readRokuConfig>;
  directory: string;
  generated: string;
  profile: RokuBuildProfile;
  fonts: ReturnType<typeof import("./fontVariants.mjs").prepareRokuFontAssets>;
  imageAssets: Record<string, import("./assets.cjs").RokuImageAssetRecord>;
  imageDirectory: string;
  refreshGraph?: import("./metroRefresh.mjs").RokuMetroRefreshGraph;
  native: { anchor: string; scene: string; entry: string; mainSource: string };
}>;
export declare function buildRokuProject(
  root?: string,
  options?: { profile?: RokuBuildProfile },
): Promise<{ bundle: string; zip: string; profile: RokuBuildProfile }>;
export declare function doctorRokuProject(root?: string): {
  status: string;
  checks: Array<{ name: string; status: string; message?: string }>;
  deviceQualified: boolean;
  qualification: string;
};
export declare function buildRokuPreview(
  root?: string,
  options?: {
    outputDirectory?: string;
    profile?: RokuBuildProfile;
    refresh?: import("./metroRefresh.mjs").RokuMetroRefreshContext;
  },
): Promise<string>;
export declare function devRokuProject(
  root?: string,
  options?: { profile?: RokuBuildProfile },
): Promise<void>;
export declare function createRokuProjectDevServer(
  root?: string,
  options?: {
    profile?: RokuBuildProfile;
    port?: number;
    onBuild?: (state: import("./dev.mjs").DevState) => void;
  },
): Promise<
  Awaited<ReturnType<typeof import("./dev.mjs").createRokuDevServer>> & {
    workspaceDirectory: string;
  }
>;
export { prepareRokuFontAssets } from "./fontVariants.mjs";

export declare function createRokuSdkConfiguration(
  root: string,
  preBuild: () => Promise<void>,
): import("@roku-sdk/rsg-ts/roku-config").RokuConfig;
