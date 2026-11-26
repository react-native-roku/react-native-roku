import { existsSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];
export const rokuSourceVariants = Object.freeze([".roku", ".tv", ""]);
/** Source variants apply to portable app/package source, never unqualified native leaves. */
export function resolveRokuSource(base) {
  const extension = extname(base);
  if (extension && !extensions.includes(extension)) return null;
  const stem = extensions.includes(extension) ? base.slice(0, -extension.length) : base;
  const suffixes = extensions.includes(extension)
    ? [...new Set([extension, ...extensions])]
    : extensions;
  for (const prefix of [stem, resolve(base, "index")])
    for (const variant of rokuSourceVariants)
      for (const suffix of suffixes) {
        const path = prefix + variant + suffix;
        if (existsSync(path) && statSync(path).isFile()) return path;
      }
  return null;
}
export function resolveRokuRelative(importer, specifier) {
  return specifier.startsWith(".")
    ? resolveRokuSource(resolve(dirname(importer), specifier))
    : null;
}
