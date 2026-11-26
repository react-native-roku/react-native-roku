export declare const toolchain: {
  node: { minimum: string; major: number };
  pnpm: string;
  packages: Record<string, string>;
  optionalPackages: { metro: Record<string, string> };
  groups: Record<string, string[]>;
};
export type RokuBuildProfile = "production" | "development";
export declare function rokuBuildProfile(name?: RokuBuildProfile): {
  readonly name: RokuBuildProfile;
  readonly development: boolean;
  readonly defines: Readonly<Record<string, string>>;
};
export declare function supportedNode(version?: string): boolean;
export declare function executable(path: string): boolean;
export declare function findCommand(name: string): string | null;
export declare function findChromium(): string | null;
export declare function installedPackage(
  root: string,
  name: string,
): { name: string; version: string };
export declare function doctorEnvironment(
  root?: string,
  options?: { browser?: boolean },
): {
  status: string;
  checks: Array<{ name: string; status: string; message?: string }>;
  deviceQualified: boolean;
};
