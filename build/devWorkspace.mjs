import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  existsSync,
  lstatSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
const OWNER = "roku-dev-owner.json";
function owner(directory) {
  try {
    return JSON.parse(readFileSync(join(directory, OWNER)));
  } catch {
    return null;
  }
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
/** Delete only abandoned directories carrying this tool's ownership manifest. */
export function cleanAbandonedDevWorkspaces(parent) {
  const removed = [];
  if (!existsSync(parent)) return removed;
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("roku-dev-")) continue;
    const directory = resolve(parent, entry.name),
      data = owner(directory);
    if (data?.schema !== "react-native-roku-dev-owner/v1" || alive(data.pid)) continue;
    rmSync(directory, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}
export function createRokuDevWorkspace(parent, { label = "preview", keep = 2 } = {}) {
  if (!Number.isInteger(keep) || keep < 2)
    throw Error("Keep at least two successful development generations");
  mkdirSync(parent, { recursive: true });
  const abandoned = cleanAbandonedDevWorkspaces(parent);
  const directory = mkdtempSync(resolve(parent, "roku-dev-")),
    token = randomUUID();
  writeFileSync(
    join(directory, OWNER),
    JSON.stringify({
      schema: "react-native-roku-dev-owner/v1",
      pid: process.pid,
      token,
      label,
      startedAt: new Date().toISOString(),
    }) + "\n",
  );
  let disposed = false;
  const owns = () => !disposed && owner(directory)?.token === token;
  return {
    directory,
    abandoned,
    generation(number) {
      if (!owns() || !Number.isSafeInteger(number) || number < 1)
        throw Error("Invalid or retired development generation");
      return resolve(directory, String(number));
    },
    publish(generation) {
      if (!owns()) return;
      for (const name of readdirSync(directory)) {
        if (!/^[1-9]\d*$/.test(name) || Number(name) > generation - keep) continue;
        const path = join(directory, name);
        if (lstatSync(path).isSymbolicLink()) continue;
        rmSync(path, { recursive: true, force: true });
      }
    },
    dispose() {
      if (!owns()) return;
      rmSync(directory, { recursive: true, force: true });
      disposed = true;
    },
  };
}
