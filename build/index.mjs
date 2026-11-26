import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
/** Public import aliases implemented by this version of the platform. */
export const adapterModules = Object.freeze(
  Object.fromEntries(
    Object.entries(
      JSON.parse(readFileSync(new URL("../compatibility/registry.json", import.meta.url))).modules,
    ).map(([name, module]) => [name, module.adapter]),
  ),
);
export function resolveAdapter(specifier) {
  return adapterModules[specifier] ? require.resolve(adapterModules[specifier]) : null;
}
export function resolveRuntime(subpath = "") {
  return require.resolve(`react-native-roku${subpath ? "/" + subpath : ""}`);
}
export function isRuntimeSource(path) {
  return path.startsWith(resolve(packageRoot, "src") + sep);
}
export const nativeComponents = Object.freeze(
  JSON.parse(readFileSync(new URL("../native/manifest.json", import.meta.url))),
);

/** Copy package-owned native mechanics into the consumer's generated tree. */
export function prepareNativeComponents(generatedDirectory) {
  const directory = resolve(generatedDirectory, "native-components");
  mkdirSync(directory, { recursive: true });
  const files = [];
  for (const name of Object.values(nativeComponents))
    for (const extension of ["xml", "brs"]) {
      const source = resolve(packageRoot, "native/components", `${name}.${extension}`);
      const target = resolve(directory, `${name}.${extension}`);
      copyFileSync(source, target);
      files.push({
        path: relative(generatedDirectory, target).split(sep).join("/"),
        sha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
      });
    }
  writeFileSync(
    resolve(generatedDirectory, "nativeComponents.ts"),
    Object.entries(nativeComponents)
      .map(([key, name]) => `export {default as ${key}} from "./native-components/${name}.xml";`)
      .join("\n") + "\n",
  );
  return { components: nativeComponents, files };
}

/** Installed source content, including native/build files, is a build input. */
export function runtimeInputs() {
  const walk = (directory) =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name.startsWith(".")) return [];
      const path = resolve(directory, entry.name);
      if (entry.isDirectory())
        return ["node_modules", "dist", "generated", "coverage"].includes(entry.name)
          ? []
          : walk(path);
      if (/\.(?:test|spec)\.|\.xml\.d\.ts$|\.md$/.test(path)) return [];
      return [
        {
          path: relative(packageRoot, path).split(sep).join("/"),
          sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
        },
      ];
    });
  return [
    ...walk(resolve(packageRoot, "config")),
    ...walk(resolve(packageRoot, "compatibility")),
    ...walk(resolve(packageRoot, "src")),
    ...walk(resolve(packageRoot, "build")),
    ...walk(resolve(packageRoot, "native")),
    ...walk(resolve(packageRoot, "bin")),
    ...walk(resolve(packageRoot, "examples/hello-roku")),
    ...["package.json", "tsconfig.consumer.json"].map((path) => ({
      path,
      sha256: createHash("sha256")
        .update(readFileSync(resolve(packageRoot, path)))
        .digest("hex"),
    })),
  ].sort((a, b) => a.path.localeCompare(b.path));
}
