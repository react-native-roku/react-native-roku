import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { resolveRuntime, packageRoot } from "./index.mjs";
import { builtinModules } from "node:module";
import { resolve, sep } from "node:path";

test("public runtime, application, preview and SDK graphs exclude Node testing IO and consumer code", async () => {
  for (const entry of ["", "application", "preview", "sdk-host"]) {
    const graph = await build({
      entryPoints: [resolveRuntime(entry)],
      absWorkingDir: packageRoot,
      bundle: true,
      packages: "external",
      platform: "browser",
      format: "esm",
      write: false,
      metafile: true,
      plugins: [
        {
          name: "runtime-boundary",
          setup(builder) {
            builder.onResolve(
              {
                filter: /^(node:|@napi-rs\/|react-native-roku\/(src\/|testing\/node($|\/)))/,
              },
              (args) => ({
                errors: [{ text: `Runtime boundary imported ${args.path} from ${args.importer}` }],
              }),
            );
            builder.onResolve({ filter: /.*/ }, (args) =>
              builtinModules.includes(args.path)
                ? { errors: [{ text: `Runtime boundary imported Node builtin ${args.path}` }] }
                : undefined,
            );
          },
        },
      ],
    });
    assert.ok(Object.keys(graph.metafile.inputs).length > 1, entry);
    for (const input of Object.keys(graph.metafile.inputs)) {
      assert.ok(!input.startsWith("build/testing/"), `${entry}: ${input}`);
      assert.ok(
        resolve(packageRoot, input).startsWith(resolve(packageRoot) + sep),
        `${entry} imported source outside the producer: ${input}`,
      );
    }
  }
});
