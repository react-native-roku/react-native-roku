import { spawnSync } from "node:child_process";
import { supportedNode, toolchain } from "../build/environment.mjs";
if (!supportedNode())
  throw Error(`Use Node ${toolchain.node.minimum} from .node-version before setup`);
for (const args of [
  ["install", "--frozen-lockfile"],
  ["run", "doctor"],
]) {
  const result = spawnSync("pnpm", args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
