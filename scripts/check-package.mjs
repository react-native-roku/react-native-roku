import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Parser, ParseMode } from "brighterscript";
import { packageRoot, runtimeInputs, resolveRuntime, adapterModules } from "../build/index.mjs";
const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json")));
assert.equal(manifest.name, "react-native-roku");
for (const [name, spec] of Object.entries({
  ...manifest.dependencies,
  ...manifest.peerDependencies,
  ...manifest.devDependencies,
}))
  assert.match(
    spec,
    /^(?:npm:(?:@[^/]+\/)?[^@]+@)?\d+\.\d+\.\d+(?:[-+][a-z\d.-]+)?$/i,
    `Expected a pinned registry package for ${name}`,
  );
for (const key of Object.keys(manifest.exports)) resolveRuntime(key === "." ? "" : key.slice(2));
for (const specifier of Object.values(adapterModules))
  assert.ok(specifier.startsWith("react-native-roku/"));
const sources = runtimeInputs();
// Parse authored helpers before packing or installing an SDK consumer. The
// independent SDK lane separately parses the actual generated package too.
for (const entry of sources.filter((entry) => entry.path.endsWith(".brs")))
  assert.deepEqual(
    Parser.parse(readFileSync(resolve(packageRoot, entry.path), "utf8"), {
      mode: ParseMode.BrightScript,
      minFirmwareVersion: "16.0.0",
    }).diagnostics,
    [],
    entry.path,
  );
assert.ok(sources.length > 100);
console.log(
  JSON.stringify({
    status: "passed",
    exports: Object.keys(manifest.exports).length,
    inputs: sources.length,
  }),
);

const consumerConfig = JSON.parse(readFileSync(resolve(packageRoot, "tsconfig.consumer.json")));
assert.deepEqual(
  consumerConfig.compilerOptions.paths,
  Object.fromEntries(
    Object.entries(adapterModules).map(([name, specifier]) => [
      name,
      [manifest.exports["." + specifier.slice("react-native-roku".length)]],
    ]),
  ),
);

const template = JSON.parse(
  readFileSync(resolve(packageRoot, "examples/hello-roku/package.template.json")),
);
assert.equal(template.dependencies[manifest.name], manifest.version);
assert.equal(
  template.dependencies.react,
  manifest.peerDependencies.react,
  "Template React must match the platform cohort",
);
for (const name of ["@roku-sdk/tooling", "@roku-sdk/dev-tools"])
  assert.equal(
    template.devDependencies[name],
    manifest.dependencies["@roku-sdk/runtime"],
    "Template SDK tooling must match the platform cohort",
  );
assert.equal(template.dependencies["@roku-sdk/rsg-ts"], manifest.dependencies["@roku-sdk/runtime"]);

const { inspectPublicApi } = await import("../build/release.mjs");
assert.deepEqual(inspectPublicApi(packageRoot).failures, []);

assert.equal(template.engines.node, manifest.engines.node);
assert.equal(template.packageManager, manifest.packageManager);
