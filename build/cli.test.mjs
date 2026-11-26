import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { packageRoot } from "./index.mjs";
import { toolchain } from "./environment.mjs";
const cli = resolve(packageRoot, "bin/react-native-roku.mjs");
test("Metro initialization selects its optional cohort and rejects invalid flags before mutation", () => {
  const root = mkdtempSync(resolve(tmpdir(), "roku-init-metro-"));
  try {
    const app = resolve(root, "app");
    execFileSync(process.execPath, [
      cli,
      "init",
      app,
      "--bundler=metro",
      "--package=file:/tmp/platform.tgz",
    ]);
    const manifest = JSON.parse(readFileSync(resolve(app, "package.json")));
    for (const [name, version] of Object.entries(toolchain.optionalPackages.metro))
      assert.equal(manifest.devDependencies[name], version);
    assert.equal(JSON.parse(readFileSync(resolve(app, "roku.config.json"))).bundler, "metro");
    assert.match(
      readFileSync(resolve(app, "babel.config.cjs"), "utf8"),
      /@react-native\/babel-preset/,
    );
    for (const flags of [
      ["--bundler=unknown"],
      ["--bundler=metro", "--bundler=esbuild"],
      ["--package=1", "--package=2"],
    ]) {
      const bad = resolve(root, "invalid");
      assert.throws(() =>
        execFileSync(process.execPath, [cli, "init", bad, ...flags], { stdio: "pipe" }),
      );
      assert.ok(!existsSync(bad));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("build/dev profiles reject unknown or repeated flags before creating a project", () => {
  const root = mkdtempSync(resolve(tmpdir(), "roku-profile-cli-"));
  try {
    for (const command of ["build", "dev"])
      for (const flags of [
        ["--profile=release"],
        ["--profile=constructor"],
        ["--profile="],
        ["--profile=production", "--profile=development"],
        ["--unknown"],
      ]) {
        assert.throws(
          () =>
            execFileSync(process.execPath, [cli, command, ...flags], { cwd: root, stdio: "pipe" }),
          (error) => /Choose Roku profile|accepts only --profile/.test(String(error.stderr)),
        );
        assert.ok(!existsSync(resolve(root, ".roku")));
      }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("project initialization keeps existing files intact and creates an app with explicit package selection", () => {
  const root = mkdtempSync(resolve(tmpdir(), "roku-init-")),
    target = resolve(root, "new-app");
  execFileSync(process.execPath, [cli, "init", target, "--package=file:/tmp/platform.tgz"]);
  const manifest = JSON.parse(readFileSync(resolve(target, "package.json")));
  assert.equal(manifest.dependencies["react-native-roku"], "file:/tmp/platform.tgz");
  assert.equal(manifest.name, "new-app");
  assert.ok(existsSync(resolve(target, "src/App.tsx")));
  assert.ok(!existsSync(resolve(target, "node_modules")));
  assert.ok(!existsSync(resolve(target, "package.template.json")));
  assert.doesNotMatch(
    readFileSync(resolve(target, "src/App.tsx"), "utf8"),
    /from ["\x27](?:\.\.\/\.\.\/|\/)/,
  );
  writeFileSync(resolve(target, "keep.txt"), "preserve");
  assert.throws(() => execFileSync(process.execPath, [cli, "init", target], { stdio: "pipe" }));
  assert.equal(readFileSync(resolve(target, "keep.txt"), "utf8"), "preserve");
  assert.throws(() =>
    execFileSync(process.execPath, [cli, "init", resolve(root, "bad"), "--unknown"], {
      stdio: "pipe",
    }),
  );
  assert.ok(!existsSync(resolve(root, "bad")));
});

test("an installed CLI copies the starter and skips generated starter directories", (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "roku-installed-init-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installed = resolve(root, "node_modules/react-native-roku");
  for (const file of [
    "package.json",
    "bin",
    "config",
    "build/environment.mjs",
    "examples/hello-roku",
  ]) {
    cpSync(resolve(packageRoot, file), resolve(installed, file), { recursive: true });
  }
  const generated = ["node_modules", "dist", ".roku", "src/generated"];
  for (const directory of generated) {
    const path = resolve(installed, "examples/hello-roku", directory);
    mkdirSync(path, { recursive: true });
    writeFileSync(resolve(path, "fixture"), "generated");
  }
  const app = resolve(root, "my-app");
  execFileSync(process.execPath, [resolve(installed, "bin/react-native-roku.mjs"), "init", app]);
  assert.ok(existsSync(resolve(app, "src/App.tsx")));
  const manifest = JSON.parse(readFileSync(resolve(app, "package.json")));
  assert.equal(
    manifest.dependencies["react-native-roku"],
    JSON.parse(readFileSync(resolve(installed, "package.json"))).version,
  );
  for (const directory of generated) assert.ok(!existsSync(resolve(app, directory)), directory);
});
