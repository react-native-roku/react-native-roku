import { basename, relative, resolve, sep } from "node:path";
import { rmSync } from "node:fs";
export { buildRokuMetroModules } from "./metroFrontend.mjs";
export { createRokuMetroRefreshSession, writeRokuRefreshBootstrap } from "./metroRefresh.mjs";

/** SDK transformations run per input module. Bound frontend modules for every
 * consumer while retaining a single application entry and linker-owned state. */
export async function buildRokuReactModules(
  configuration,
  { partition = true, maxModuleBytes = 2 * 1024 * 1024 } = {},
) {
  const { build } = await import("esbuild");
  const root = configuration.absWorkingDir ?? process.cwd();
  if (
    !configuration.outfile ||
    !Array.isArray(configuration.entryPoints) ||
    configuration.entryPoints.length !== 1 ||
    typeof configuration.entryPoints[0] !== "string"
  )
    throw Error("A Roku React frontend needs one file entry and an outfile");
  if (!Number.isSafeInteger(maxModuleBytes) || maxModuleBytes <= 0)
    throw Error("Invalid frontend module budget");
  let result = await build({ ...configuration, metafile: true });
  if (!partition) return result;
  const written = new Set();
  const remember = (value) => {
    if (configuration.write !== false)
      for (const path of Object.keys(value.metafile.outputs)) written.add(resolve(root, path));
  };
  const finish = (value) => {
    const retained = new Set(
      Object.keys(value.metafile.outputs).map((path) => resolve(root, path)),
    );
    // Only retire files written by this invocation. Other output files and
    // buffered builds remain owned by the caller's generation policy.
    for (const path of written) if (!retained.has(path)) rmSync(path, { force: true });
    return value;
  };
  const oversizedModules = (value) =>
    Object.entries(value.metafile.outputs).filter(
      ([path, file]) => /\.[cm]?js$/.test(path) && file.bytes > maxModuleBytes,
    );
  remember(result);
  if (!oversizedModules(result).length) return finish(result);
  const output = resolve(root, configuration.outfile);
  const weights = Object.entries(
    result.metafile.outputs[relative(root, output).split(sep).join("/")]?.inputs ?? {},
  )
    .filter(([path]) => /\.[cm]?[jt]sx?$/.test(path) && !path.startsWith("<"))
    .sort((a, b) => b[1].bytesInOutput - a[1].bytesInOutput);
  let oversized = [];
  for (const count of [128, 256, 512]) {
    const anchors = weights.slice(0, count).map(([path]) => resolve(root, path));
    result = await build({
      ...configuration,
      metafile: true,
      outfile: undefined,
      outdir: resolve(output, ".."),
      entryPoints: {
        [basename(output).replace(/\.[^.]+$/, "")]: configuration.entryPoints[0],
        ...Object.fromEntries(anchors.map((path, index) => [`partitions/module-${index}`, path])),
      },
      splitting: true,
      outExtension: { ".js": ".mjs" },
      chunkNames: "chunks/[name]-[hash]",
    });
    remember(result);
    oversized = oversizedModules(result);
    if (!oversized.length) return finish(result);
    if (anchors.length === weights.length) break;
  }
  throw Error(
    `Review frontend partitioning before SDK transformation: ${oversized.map(([path, value]) => `${path} (${value.bytes} bytes)`).join(", ")}`,
  );
}
