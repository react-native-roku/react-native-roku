import test from "node:test";
import assert from "node:assert/strict";
import { supportedNode, toolchain, installedPackage, rokuBuildProfile } from "./environment.mjs";
import { buildSync } from "esbuild";
import { runInNewContext } from "node:vm";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
test("profiles compile real React and environment branches without ambient process globals", () => {
  for (const name of ["production", "development"]) {
    const profile = rokuBuildProfile(name);
    const result = buildSync({
      stdin: {
        contents:
          'import {createElement} from "react"; export const environment=process.env.NODE_ENV; export const label=__DEV__?"development":"production"; export const element=createElement("label",null,label);',
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      format: "cjs",
      platform: "neutral",
      define: profile.defines,
      metafile: true,
    });
    const module = { exports: {} };
    runInNewContext(result.outputFiles[0].text, { module, exports: module.exports });
    assert.equal(module.exports.environment, name);
    assert.equal(module.exports.label, name);
    assert.equal(module.exports.element.props.children, name);
    const bytes = (suffix) =>
      Object.values(result.metafile.outputs)
        .flatMap((output) => Object.entries(output.inputs))
        .filter(([path]) => path.endsWith(suffix))
        .reduce((sum, [, value]) => sum + value.bytesInOutput, 0);
    assert.ok(bytes("react." + name + ".js") > 0);
    assert.equal(bytes("react." + (profile.development ? "production" : "development") + ".js"), 0);
    assert.ok(Object.isFrozen(profile) && Object.isFrozen(profile.defines));
  }
  assert.equal(rokuBuildProfile().name, "production");
  for (const name of ["", "constructor", "release", true, null])
    assert.throws(() => rokuBuildProfile(name), /Choose Roku profile/);
});
test("doctor reads version metadata for packages exposing only SDK subpaths", () => {
  const root = mkdtempSync(resolve(tmpdir(), "roku-metadata-"));
  try {
    writeFileSync(resolve(root, "package.json"), "{}");
    mkdirSync(resolve(root, "node_modules/subpath-only"), { recursive: true });
    writeFileSync(
      resolve(root, "node_modules/subpath-only/package.json"),
      JSON.stringify({
        name: "subpath-only",
        version: "1.2.3",
        exports: { "./thing": "./thing.js" },
      }),
    );
    assert.equal(installedPackage(root, "subpath-only").version, "1.2.3");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("supported toolchain rejects older/new-major Node and manifests use one floor", () => {
  for (const version of ["24.18.0", "24.3.0", "23.99.0", "25.0.0", "24.18.1-rc.1"])
    assert.equal(supportedNode(version), false, version);
  for (const version of ["24.18.1", "24.19.0", "24.18.2"])
    assert.equal(supportedNode(version), true, version);
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  assert.equal(manifest.engines.node, `>=${toolchain.node.minimum} <25`);
  assert.equal(
    readFileSync(new URL("../.node-version", import.meta.url), "utf8").trim(),
    toolchain.node.minimum,
  );
});
