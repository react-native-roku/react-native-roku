import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [archive, directory, screen = "catalog"] = process.argv.slice(2);
assert.ok(
  archive && directory && ["catalog", "images", "settings", "clipping"].includes(screen),
  "Usage: node prepare.mjs RENDERER.tgz NEW_DIRECTORY [catalog|images|settings|clipping]",
);
const output = resolve(directory);
const app = join(output, "app"),
  extracted = join(output, "tool");
mkdirSync(output, { mode: 0o700 });
mkdirSync(extracted);
const bytes = readFileSync(archive);
const hash = (data) => createHash("sha256").update(data).digest("hex");
writeFileSync(join(output, "runtime.tgz"), bytes);
execFileSync("tar", ["-xf", join(output, "runtime.tgz"), "-C", extracted]);
execFileSync(
  process.execPath,
  [
    join(extracted, "package/bin/react-native-roku.mjs"),
    "init",
    app,
    "--package=file:../runtime.tgz",
  ],
  { stdio: "inherit" },
);
const entry = {
  catalog: "Catalog.tsx",
  images: "Gallery.tsx",
  settings: "Settings.tsx",
  clipping: "Clipping.tsx",
}[screen];
if (screen === "clipping") {
  for (const file of [entry, "coreUiFixture.tsx"])
    copyFileSync(
      join(import.meta.dirname, "../../examples/minimal/src", file),
      join(app, "src", file),
    );
} else if (screen !== "catalog") {
  copyFileSync(join(import.meta.dirname, entry), join(app, "src", entry));
}
const config = join(app, "roku.config.json");
const manifest = JSON.parse(readFileSync(config));
if (screen === "settings") manifest.storageNamespace = "rnr_settings_fixture";
manifest.entry = "src/" + entry;
writeFileSync(config, JSON.stringify(manifest, null, 2) + "\n");
const lock = readFileSync(join(import.meta.dirname, "pnpm-lock.yaml"), "utf8");
const marker = /integrity: sha512-[^,\r\n]+, tarball: file:\.\.\/runtime\.tgz/g;
assert.equal([...lock.matchAll(marker)].length, 1, "Expected one archive integrity entry");
writeFileSync(
  join(app, "pnpm-lock.yaml"),
  lock.replace(
    marker,
    "integrity: sha512-" +
      createHash("sha512").update(bytes).digest("base64") +
      ", tarball: file:../runtime.tgz",
  ),
);
for (const args of [
  ["install", "--frozen-lockfile"],
  ["run", "typecheck"],
  ["run", "build"],
])
  execFileSync("pnpm", args, { cwd: app, stdio: "inherit" });
const zip = join(app, "dist/roku-app.zip");
execFileSync("unzip", ["-tq", zip]);
copyFileSync(zip, join(output, "fixture.zip"));
writeFileSync(
  join(output, "inputs.json"),
  JSON.stringify(
    {
      archiveSha256: hash(bytes),
      zipSha256: hash(readFileSync(zip)),
      screen,
      entrySha256: hash(readFileSync(join(app, "src", entry))),
      lockSha256: hash(readFileSync(join(app, "pnpm-lock.yaml"))),
    },
    null,
    2,
  ) + "\n",
);
