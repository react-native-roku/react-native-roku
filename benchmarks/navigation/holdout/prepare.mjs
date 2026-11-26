import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;
const shelf = resolve(here, "../../shelf");
const example = resolve(here, "../../../examples/hello-roku/src");

// Reuse the locked shelf SDK projects, archive installer and manifest/font verification.
export function stage(root) {
  for (const path of ["prepare.mjs", "react", "solid", "shared", "diagnostic"])
    cpSync(join(shelf, path), join(root, path), { recursive: true });
  const hashes = {};
  for (const renderer of ["react", "solid"]) {
    const screen = renderer === "react" ? "React.tsx" : "Solid.tsx";
    for (const [source, target] of [
      [join(here, screen), "CatalogScreen.tsx"],
      [join(here, "model.ts"), "holdout.ts"],
      [join(example, "catalog-cover.png"), "catalog-cover.png"],
    ]) {
      copyFileSync(source, join(root, renderer, "src", target));
      hashes[renderer + "/" + target] = createHash("sha256")
        .update(readFileSync(source))
        .digest("hex");
    }
    if (renderer === "react")
      copyFileSync(join(example, "assets.d.ts"), join(root, renderer, "src/holdout-assets.d.ts"));
  }
  return hashes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [archive, output, mode] = process.argv.slice(2);
  if (!archive || !output || (mode && mode !== "react"))
    throw Error("Usage: node prepare.mjs ARCHIVE.tgz NEW_OUTPUT [react]");
  const scratch = mkdtempSync(join(tmpdir(), "roku-navigation-holdout-"));
  try {
    const sources = stage(scratch);
    execFileSync(
      process.execPath,
      [join(scratch, "prepare.mjs"), resolve(archive), resolve(output), ...(mode ? [mode] : [])],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          ROKU_SHELF_WORKLOAD: "catalog",
          ROKU_SHELF_MARKS: "0",
          ROKU_SHELF_ACTIVATION: "0",
        },
      },
    );
    writeFileSync(
      join(output, "holdout-inputs.json"),
      JSON.stringify({ version: 1, sources }, null, 2),
      { flag: "wx" },
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
