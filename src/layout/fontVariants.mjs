/** Shared asset identity for runtime selection and build-time face generation.
 * A variant needs an actual font asset; no native font feature field is assumed. */
export function fontVariantFamily(family, variants) {
  if (variants == null) return family;
  if (!Array.isArray(variants) || variants.some((value) => value !== "tabular-nums"))
    throw Error("C04_FONT_VARIANT: Only the configured tabular-nums face is implemented");
  return variants.length ? `${family}::tabular-nums` : family;
}
