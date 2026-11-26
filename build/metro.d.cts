export declare function withRoku<
  T extends { projectRoot?: string; resolver?: Record<string, unknown> },
>(config: T, options?: { root?: string }): T & { resolver: Record<string, unknown> };

type BabelTransformer = {
  transform: (...args: never[]) => unknown;
  getCacheKey?: (...args: never[]) => string | Uint8Array;
};
type ImageOptions = Omit<import("./assets.cjs").RokuImageAssetsOptions, "root" | "reset">;
type TransformerOptions = {
  root?: string;
  generatedDirectory?: string;
  plugins?: readonly string[];
  preparedSourcesPath?: string;
  fastRefresh?: boolean;
};
type CacheKey<T extends BabelTransformer> = {
  getCacheKey(...args: T extends { getCacheKey: (...args: infer P) => unknown } ? P : []): string;
};
type ImageTransformer<T extends BabelTransformer> = Omit<T, "transform" | "getCacheKey"> &
  CacheKey<T> & {
    transform(
      ...args: Parameters<T["transform"]>
    ): ReturnType<T["transform"]> | Promise<Awaited<ReturnType<T["transform"]>>>;
  };
export declare function withRokuBabelTransformer<T extends BabelTransformer>(
  upstream: T,
  options: TransformerOptions & { imageAssets: ImageOptions },
): ImageTransformer<T>;
export declare function withRokuBabelTransformer<T extends BabelTransformer>(
  upstream: T,
  options?: TransformerOptions & { imageAssets?: undefined | false },
): Omit<T, "getCacheKey"> & CacheKey<T>;
export declare function withRokuBabelTransformer<T extends BabelTransformer>(
  upstream: T,
  options: TransformerOptions & { imageAssets?: ImageOptions | false },
): ImageTransformer<T>;
