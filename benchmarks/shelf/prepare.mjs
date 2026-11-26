import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [archivePath, outputPath, mode = "build"] = process.argv.slice(2);
assert.ok(
  archivePath && outputPath && ["build", "host", "react", "solid-full"].includes(mode),
  "Usage: node prepare.mjs RENDERER.tgz NEW_OUTPUT [build|host|react|solid-full]",
);
const archive = resolve(archivePath);
const bytes = readFileSync(archive);
const output = resolve(outputPath);
mkdirSync(output, { mode: 0o700 });
const hash = (data, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(data).digest(encoding);
const archiveSha256 = hash(bytes);
writeFileSync(join(output, "runtime.tgz"), bytes, { flag: "wx" });
const root = import.meta.dirname;
const font = "400Regular/Inter_400Regular.ttf";
const fontSha256 = "a414b48aa577ef2c62ebb135341ddeef33ee26a4f5dc9f787f93c1aab08ebb50";
const catalog = process.env.ROKU_SHELF_WORKLOAD === "catalog";
const marks = process.env.ROKU_SHELF_MARKS === "1";
const activation = process.env.ROKU_SHELF_ACTIVATION === "1";
const fullTitles = mode === "solid-full";
assert.ok(!fullTitles || catalog, "The full-title reference requires the catalog workload");
const projects =
  mode === "build" ? ["react", "solid"] : fullTitles ? ["react", "solid-full"] : ["react"];
const buildProjects = fullTitles ? ["solid-full"] : projects;
const pnpm = (cwd, args) => execFileSync("pnpm", args, { cwd, stdio: "inherit" });
for (const name of projects) {
  const cwd = join(output, name);
  cpSync(join(root, name === "react" ? name : "solid"), cwd, { recursive: true });
  copyFileSync(join(root, "shared/shelf.ts"), join(cwd, "src/shelf.ts"));
  copyFileSync(join(root, "diagnostic/marker.ts"), join(cwd, "src/shelfTrace.ts"));
  writeFileSync(
    join(cwd, "src/shelfMode.ts"),
    `export const marks = ${marks};\nexport const activation = ${activation};\nexport const catalog = ${catalog};\n`,
  );
  if (name === "solid-full") {
    writeFileSync(
      join(cwd, "src/fullCatalogTitles.ts"),
      "export const fullCatalogTitles = true;\n",
    );
    const config = join(cwd, "roku-config.ts");
    const original = readFileSync(config, "utf8");
    assert.match(original, /minor_version: 1,/);
    writeFileSync(config, original.replace("minor_version: 1,", "minor_version: 2,"));
  }
  if (name !== "react" && marks) {
    const scene = join(cwd, "src/NativeShelfScene.brs");
    const source = readFileSync(scene, "utf8");
    assert.equal(source.split("end sub").length, 2);
    writeFileSync(
      scene,
      source.replace("end sub", "    startShelfFocusProbe()\nend sub") +
        readFileSync(join(root, "diagnostic/native.brs"), "utf8") +
        Array.from(
          { length: 24 },
          (_, card) =>
            `\nsub shelfNativeFocus${card}(event as Object)\n    shelfNativeFocus(event)\nend sub\n`,
        ).join(""),
    );
  }
  if (name === "react") {
    const lockPath = join(cwd, "pnpm-lock.yaml");
    const lock = readFileSync(lockPath, "utf8");
    const entry = /integrity: sha512-[^,\r\n]+, tarball: file:\.\.\/runtime\.tgz/g;
    assert.equal([...lock.matchAll(entry)].length, 1, "Expected one renderer tarball in the lock");
    writeFileSync(
      lockPath,
      lock.replace(
        entry,
        `integrity: sha512-${hash(bytes, "sha512", "base64")}, tarball: file:../runtime.tgz`,
      ),
    );
  } else {
    const fontPath = join(output, "react/node_modules/@expo-google-fonts/inter", font);
    assert.equal(hash(readFileSync(fontPath)), fontSha256);
    copyFileSync(fontPath, join(cwd, "src/Inter_400Regular.ttf"));
  }
  pnpm(cwd, ["install", "--frozen-lockfile"]);
}
writeFileSync(
  join(output, "inputs.json"),
  JSON.stringify(
    {
      archiveSha256,
      fontSha256,
      sdk: "2.19.1",
      marks,
      activation,
      catalog,
      ...(fullTitles && { solidReference: "full-title-v2" }),
      fixtureSha256: hash(readFileSync(join(root, "shared/shelf.ts"))),
    },
    null,
    2,
  ) + "\n",
);
if (mode !== "host") {
  for (const name of buildProjects) {
    const cwd = join(output, name);
    // rk generates the Solid XML declarations while building.
    pnpm(cwd, ["run", "build"]);
    pnpm(cwd, ["run", "typecheck"]);
    if (name !== "react")
      execFileSync("zip", ["-q", "-r", join(output, name + ".zip"), "."], {
        cwd: join(cwd, "dist/sdk/bundle"),
      });
    else copyFileSync(join(cwd, "dist/roku-app.zip"), join(output, "react.zip"));
  }
}

if (mode !== "host") {
  const zips = Object.fromEntries(
    buildProjects.map((name) => {
      const file = name + ".zip";
      const path = join(output, file);
      const zip = readFileSync(path);
      execFileSync("unzip", ["-tq", path]);
      execFileSync("unzip", ["-p", path, "source/Main.brs"]);
      const fontPath = name === "react" ? "fonts/font-0.ttf" : "fonts/Inter_400Regular.ttf";
      assert.equal(hash(execFileSync("unzip", ["-p", path, fontPath])), fontSha256);
      const manifest = execFileSync("unzip", ["-p", path, "manifest"], { encoding: "utf8" });
      const settings = Object.fromEntries(
        manifest
          .trim()
          .split(/\r?\n/)
          .map((line) => line.split("=", 2)),
      );
      for (const [key, expected] of Object.entries({
        ui_resolutions: "fhd",
        rsg_version: "2.0",
        run_as_process: "1",
        sdk_instant_resume: "1",
      }))
        assert.equal(settings[key], expected, `${name} manifest ${key}`);
      return [name, { file, sha256: hash(zip), md5: hash(zip, "md5"), bytes: zip.length }];
    }),
  );
  writeFileSync(join(output, "zips.json"), JSON.stringify(zips, null, 2) + "\n");
}
