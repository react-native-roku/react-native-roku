import { inspectRelease } from "../build/release.mjs";
const args = process.argv.slice(2);
if (args.some((value) => !["--check", "--prepare"].includes(value)))
  throw Error("Usage: pnpm release:prepare | pnpm release:check");
const result = inspectRelease(process.cwd(), {
  workflowRepository:
    process.env.GITHUB_ACTIONS === "true" ? process.env.GITHUB_REPOSITORY : undefined,
  tag: process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined,
});
console.log(JSON.stringify(result, null, 2));
if (args.includes("--check") && !result.ready) process.exitCode = 1;
