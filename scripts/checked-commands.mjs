import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { packageRoot } from "../build/index.mjs";
import { ensureQualificationStorage } from "./qualificationStorage.mjs";
import { qualifyPackage, verifyPackedQualification } from "./qualify-package.mjs";

const group = process.argv[2];
if (!["fast", "tests", "full"].includes(group)) throw Error("Choose fast, tests or full checks");
if (group === "full") {
  const directory = resolve(packageRoot, ".local/package-check-" + randomUUID());
  if (!process.argv.some((arg) => arg.startsWith("--output=")))
    process.argv.push("--output=" + resolve(directory, "evidence"));
  if (!process.argv.some((arg) => arg.startsWith("--archive=")))
    process.argv.push("--archive=" + resolve(directory, "runtime.tgz"));
  if (existsSync(process.argv.find((arg) => arg.startsWith("--archive=")).slice(10)))
    throw Error("Choose a fresh package-check archive; existing evidence is preserved");
}
const archive = process.argv.find((arg) => arg.startsWith("--archive="))?.slice(10);
await ensureQualificationStorage({
  projectRoot: packageRoot,
  kind: "producer-" + group,
  cleanupSuccess: true,
  track: archive ? [resolve(archive, "..")] : [],
});
function run(program, args) {
  const result = spawnSync(program, args, { cwd: packageRoot, env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (group === "tests") {
  run(process.execPath, [resolve(packageRoot, "node_modules/vitest/vitest.mjs"), "run"]);
  run(process.execPath, [
    "--test",
    ...readdirSync(resolve(packageRoot, "build"))
      .filter((name) => name.endsWith(".test.mjs"))
      .sort()
      .map((name) => "build/" + name),
    "build/testing/node.test.mjs",
  ]);
} else if (group === "fast") {
  for (const script of [
    "format:check",
    "typecheck",
    "test",
    "check:package",
    "check:compatibility",
    "check:independence",
    "test:navigation",
  ])
    run("pnpm", [script]);
} else {
  run("pnpm", ["check:fast"]);
  mkdirSync(dirname(resolve(archive)), { recursive: true });
  run("pnpm", ["pack", "--out", archive]);
  const output = process.argv.find((arg) => arg.startsWith("--output=")).slice(9);
  const result = qualifyPackage(["--archive=" + archive, "--output=" + output]);
  verifyPackedQualification({ archive, output, manifestSha256: result.manifestSha256 });
  console.log(JSON.stringify(result));
}
