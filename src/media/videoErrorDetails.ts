/** Only bounded machine fields cross the adapter. Native debug/message/source
 * strings may contain media URLs, headers or credentials and are not retained. */
export interface NativeVideoErrorDetails {
  readonly nativeCode?: number;
  readonly internalCode?: number;
  readonly drmCode?: number;
  readonly category?: "http" | "drm" | "mediaerror" | "mediaplayer";
  readonly clipId?: number;
  readonly ignored?: boolean;
}

export const nativeErrorCode = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= -2147483648 &&
  value <= 2147483647;

export function nativeVideoErrorInfo(value: unknown): NativeVideoErrorDetails | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const info = value as Record<string, unknown>;
  const own = (key: string) => (Object.hasOwn(info, key) ? info[key] : undefined);
  const result: { -readonly [K in keyof NativeVideoErrorDetails]: NativeVideoErrorDetails[K] } = {};
  const code = own("errcode"),
    drmCode = own("drmerrcode"),
    clipId = own("clipId"),
    ignored = own("ignored"),
    category = own("category");
  if (nativeErrorCode(code) && code !== 0) result.internalCode = code;
  if (nativeErrorCode(drmCode) && drmCode !== 0) result.drmCode = drmCode;
  if (nativeErrorCode(clipId) && clipId >= 0) result.clipId = clipId;
  if (ignored === 0 || ignored === 1) result.ignored = ignored === 1;
  if (
    category === "http" ||
    category === "drm" ||
    category === "mediaerror" ||
    category === "mediaplayer"
  )
    result.category = category;
  return Object.keys(result).length ? Object.freeze(result) : undefined;
}
