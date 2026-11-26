export interface CompatibilityApi {
  status: string;
  members: string[];
  props: string[];
  openProps: boolean;
  limitations?: string;
}
export interface CompatibilityModule {
  adapter: string;
  source: string;
  version: string;
  limitations: string;
  contracts: string[];
  device: string;
  exports: Record<string, CompatibilityApi>;
}
export declare const compatibility: {
  schema: string;
  modules: Record<string, CompatibilityModule>;
  contracts: Record<string, { tests: string[]; scope: string }>;
};
export declare function discoverAdapterSurface(
  root: string,
  modules?: Record<string, CompatibilityModule>,
): Record<string, Record<string, { members: string[]; props: string[]; openProps: boolean }>>;
export declare function auditCompatibility(options: {
  root: string;
  files: string[];
  libraries?: Record<string, unknown>;
  sourceOnly?: boolean;
  workspacePrefixes?: string[];
}): {
  schema: string;
  status: string;
  deviceQualified: boolean;
  imports: Array<{ module: string }>;
  dynamic: unknown[];
  violations: Array<{ id: string; file: string; line: number; message: string; context: string }>;
  limitations: string[];
};
