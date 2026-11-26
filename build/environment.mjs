import { readFileSync, existsSync, accessSync, constants } from "node:fs";
import { resolve, dirname, delimiter } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

export const toolchain = Object.freeze(
  JSON.parse(readFileSync(new URL("../config/toolchain.json", import.meta.url))),
);
const buildProfiles = Object.freeze(
  Object.fromEntries(
    ["production", "development"].map((name) => [
      name,
      Object.freeze({
        name,
        development: name === "development",
        defines: Object.freeze({
          global: "globalThis",
          __DEV__: JSON.stringify(name === "development"),
          "process.env.NODE_ENV": JSON.stringify(name),
          "process.env": JSON.stringify({ NODE_ENV: name }),
        }),
      }),
    ]),
  ),
);
/** React compilation profile; channel identity and deployment remain consumer policy. */
export function rokuBuildProfile(name = "production") {
  if (typeof name !== "string" || !Object.hasOwn(buildProfiles, name))
    throw Error("Choose Roku profile production or development");
  return buildProfiles[name];
}
export function supportedNode(version = process.versions.node) {
  const parts = version.replace(/^v/, "").split(".").map(Number);
  const floor = toolchain.node.minimum.split(".").map(Number);
  return (
    parts.length === 3 &&
    parts.every(Number.isInteger) &&
    parts[0] === toolchain.node.major &&
    (parts[1] > floor[1] || (parts[1] === floor[1] && parts[2] >= floor[2]))
  );
}
export function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
export function findCommand(name) {
  return (
    (process.env.PATH ?? "")
      .split(delimiter)
      .map((directory) => resolve(directory, name))
      .find(executable) ?? null
  );
}
export function findChromium() {
  const explicit = process.env.ROKU_TEST_CHROMIUM;
  if (explicit) return executable(explicit) ? explicit : null;
  return (
    [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome",
      findCommand("google-chrome"),
      findCommand("chromium"),
    ].find((path) => path && executable(path)) ?? null
  );
}
export function installedPackage(root, name) {
  const require = createRequire(resolve(root, "package.json"));
  let path;
  try {
    path = require.resolve(`${name}/package.json`);
  } catch {
    // Some SDK packages expose only subpaths, with neither a root entry nor
    // package.json exported. Read metadata through Node's package search paths.
    for (const directory of require.resolve.paths(name) ?? []) {
      const candidate = resolve(directory, name, "package.json");
      if (existsSync(candidate)) {
        path = candidate;
        break;
      }
    }
    if (path) return JSON.parse(readFileSync(path));
    let directory = dirname(require.resolve(name));
    while (directory !== dirname(directory)) {
      const candidate = resolve(directory, "package.json");
      if (existsSync(candidate) && JSON.parse(readFileSync(candidate)).name === name) {
        path = candidate;
        break;
      }
      directory = dirname(directory);
    }
  }
  if (!path) throw Error(`Cannot locate ${name}`);
  return JSON.parse(readFileSync(path));
}
export function doctorEnvironment(root = process.cwd(), { browser = true } = {}) {
  const checks = [];
  const check = (name, work) => {
    try {
      const message = work();
      checks.push({ name, status: "passed", ...(message ? { message } : {}) });
    } catch (error) {
      checks.push({ name, status: "failed", message: error.message });
    }
  };
  check("Node", () => {
    if (!supportedNode())
      throw Error(`Use Node >=${toolchain.node.minimum} <25; found ${process.versions.node}`);
  });
  check("host OS", () => {
    if (!["darwin", "linux"].includes(process.platform))
      throw Error("Build/development qualification supports macOS and Linux");
  });
  check("pnpm", () => {
    const result = spawnSync("pnpm", ["--version"], { encoding: "utf8", timeout: 10000 });
    if (result.status !== 0 || result.stdout.trim() !== toolchain.pnpm)
      throw Error(`Use pnpm ${toolchain.pnpm}`);
  });
  for (const name of ["zip", "unzip", "tar"])
    check(name, () => {
      if (!findCommand(name)) throw Error(`Install ${name} and add it to PATH`);
    });
  if (browser)
    check("Chromium", () => {
      const path = findChromium();
      if (!path) throw Error("Install Chrome/Chromium or set ROKU_TEST_CHROMIUM to its executable");
      return path;
    });
  for (const [name, version] of Object.entries(toolchain.packages))
    check(name, () => {
      if (installedPackage(root, name).version !== version)
        throw Error(`Expected ${name}@${version}; reinstall the pinned graph`);
    });
  return {
    status: checks.every((value) => value.status === "passed") ? "passed" : "failed",
    checks,
    deviceQualified: false,
  };
}
