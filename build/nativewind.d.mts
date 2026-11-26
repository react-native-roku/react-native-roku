import type { createRequire } from "node:module";
export declare function nativewindLeaf(
  specifier: string,
  importer: string,
  require: ReturnType<typeof createRequire>,
): string | null;
export declare function retainNativewindHookLifetimes(source: string): string;
export declare function prepareNativewindInterop(source: string, interopModule?: string): string;
export declare function prepareNativewindPreferences(source: string): string;
