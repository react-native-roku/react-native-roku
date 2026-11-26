export declare const packageRoot: string;
export declare const adapterModules: Readonly<Record<string, string>>;
export declare function resolveAdapter(specifier: string): string | null;
export declare function resolveRuntime(subpath?: string): string;
export declare function isRuntimeSource(path: string): boolean;
export interface RuntimeInput {
  readonly path: string;
  readonly sha256: string;
}
export interface NativeComponents {
  readonly AppControl: string;
  readonly TextRaster: string;
  readonly TextRasterTask: string;
  readonly DeviceFacts: string;
  readonly DeviceFactsTask: string;
}
export declare const nativeComponents: NativeComponents;
export declare function prepareNativeComponents(generatedDirectory: string): {
  components: NativeComponents;
  files: RuntimeInput[];
};
export declare function runtimeInputs(): RuntimeInput[];
