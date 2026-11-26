import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** CLI boundary only. A delegated child inherits one monitored workspace. */
export async function ensureQualificationStorage({
  projectRoot,
  evidence,
  track = [],
  dynamic = [],
  kind = "qualification",
  cleanupSuccess = false,
  sourceInputs = [],
} = {}) {
  const runLimit = process.env.RNR_QUALIFICATION_RUN_LIMIT_GIB;
  if (runLimit !== undefined && !/^(?:[1-9]|1[0-2])$/.test(runLimit))
    throw Error("RNR_QUALIFICATION_RUN_LIMIT_GIB must be an integer from 1 to 12");
  const session = process.env.RNR_STORAGE_SESSION;
  const backend = resolve(dirname(fileURLToPath(import.meta.url)), "qualification_storage.py");
  if (session) {
    const validated = spawnSync("python3", [backend, "session"], {
      env: process.env,
      encoding: "utf8",
    });
    if (validated.error) throw validated.error;
    if (validated.status !== 0)
      throw Error(validated.stderr.trim() || "Stale or mismatched qualification storage session");
    console.log(validated.stdout.trim());
    return;
  }
  projectRoot = resolve(projectRoot);
  const output = process.argv.find((arg) => arg.startsWith("--output="))?.slice(9);
  evidence ??= process.env.ROKU_QUALIFY_EVIDENCE_DIR ?? output;
  const archive =
    process.env.ROKU_QUALIFY_ARCHIVE ??
    process.argv.find((arg) => arg.startsWith("--archive="))?.slice(10);
  const identity =
    archive && existsSync(resolve(archive))
      ? createHash("sha256")
          .update(readFileSync(resolve(archive)))
          .digest("hex")
      : "working-tree";
  const store =
    process.env.RNR_QUALIFICATION_STORAGE_ROOT ??
    resolve(projectRoot, "../.react-native-roku-qualification");
  const args = [
    backend,
    "run",
    "--project",
    projectRoot,
    "--store",
    store,
    "--identity",
    identity,
    "--kind",
    kind,
    ...(runLimit === undefined ? [] : ["--run-limit-gib", runLimit]),
    ...(evidence ? ["--evidence", resolve(evidence)] : []),
    ...track.flatMap((path) => ["--track", resolve(projectRoot, path)]),
    ...(dynamic.length ? dynamic : evidence ? [] : [".local"]).flatMap((path) => [
      "--dynamic",
      resolve(projectRoot, path),
    ]),
    ...(cleanupSuccess ? ["--cleanup-success"] : []),
    ...[fileURLToPath(import.meta.url), process.argv[1], ...sourceInputs].flatMap((path) => [
      "--input",
      resolve(path),
    ]),
    "--",
    process.execPath,
    ...process.execArgv,
    ...process.argv.slice(1),
  ];
  const child = spawn("python3", args, { cwd: projectRoot, stdio: "inherit", env: process.env });
  const interrupt = (signal) => child.kill(signal);
  const onInt = () => interrupt("SIGINT"),
    onTerm = () => interrupt("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  }).finally(() => {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  });
  process.exit(code);
}
