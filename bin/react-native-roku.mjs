#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { resolve, basename, relative, join } from "node:path";
import { fileURLToPath } from "node:url";
import { supportedNode, toolchain, rokuBuildProfile } from "../build/environment.mjs";
if (!supportedNode())
  throw Error(`Use Node >=${toolchain.node.minimum} <25 before running react-native-roku`);

const [command, destination, ...options] = process.argv.slice(2);
if (command === "--help" || !command) {
  console.log(
    "Usage: react-native-roku <init|dev|build|doctor>\ninit <new-directory> [--package=<version-or-file:archive>] [--bundler=esbuild|metro]\nbuild|dev [--profile=production|development]\nBuild defaults to production React; dev defaults to development. Neither installs or deploys a channel.",
  );
} else if (["build", "dev", "doctor"].includes(command)) {
  const flags = [destination, ...options].filter((value) => value !== undefined);
  if (
    command === "doctor"
      ? flags.length
      : flags.length > 1 || flags.some((value) => !value.startsWith("--profile="))
  )
    throw Error("This command accepts only --profile=production|development on build/dev");
  const profile = rokuBuildProfile(
    flags[0]?.slice(10) ?? (command === "dev" ? "development" : "production"),
  ).name;
  const api = await import("../build/project.mjs");
  if (command === "doctor") {
    const result = api.doctorRokuProject();
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "passed") process.exitCode = 1;
  } else if (command === "build")
    console.log(JSON.stringify(await api.buildRokuProject(process.cwd(), { profile })));
  else await api.devRokuProject(process.cwd(), { profile });
} else {
  if (
    command !== "init" ||
    !destination ||
    options.some((value) => !value.startsWith("--package=") && !value.startsWith("--bundler=")) ||
    options.length > 2 ||
    new Set(options.map((value) => value.split("=")[0])).size !== options.length
  )
    throw Error(
      "Usage: react-native-roku init <new-directory> [--package=<version-or-file:archive>] [--bundler=esbuild|metro]",
    );
  const target = resolve(destination);
  if (existsSync(target)) throw Error("The destination already exists; choose a new directory.");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const version = JSON.parse(readFileSync(resolve(root, "package.json"))).version;
  const packageSpecifier =
    options.find((value) => value.startsWith("--package="))?.slice("--package=".length) ?? version;
  const bundler =
    options.find((value) => value.startsWith("--bundler="))?.slice("--bundler=".length) ??
    "esbuild";
  if (!["esbuild", "metro"].includes(bundler)) throw Error("Choose Roku bundler esbuild or metro");
  if (!packageSpecifier.trim()) throw Error("The package specifier must not be empty.");
  const starter = resolve(root, "examples/hello-roku");
  const excluded = new Set(["node_modules", "dist", ".roku", join("src", "generated")]);
  cpSync(starter, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (path) => !excluded.has(relative(starter, path)),
  });
  const template = resolve(target, "package.template.json");
  const manifest = JSON.parse(readFileSync(template));
  manifest.name =
    basename(target)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "roku-app";
  manifest.dependencies["react-native-roku"] = packageSpecifier;
  if (bundler === "metro") {
    Object.assign(manifest.devDependencies, toolchain.optionalPackages.metro);
    const configPath = resolve(target, "roku.config.json");
    const config = JSON.parse(readFileSync(configPath));
    config.bundler = "metro";
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    writeFileSync(
      resolve(target, "babel.config.cjs"),
      'module.exports={presets:["@react-native/babel-preset"]};\n',
    );
  }
  writeFileSync(resolve(target, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  rmSync(template);
  rmSync(resolve(target, ".npmignore"), { force: true });
  // Generated projects own their manifest and lockfile.
  writeFileSync(resolve(target, ".gitignore"), "node_modules/\n.roku/\ndist/\n");
  writeFileSync(resolve(target, ".node-version"), toolchain.node.minimum + "\n");
  console.log(
    `Created ${target}\nNext: cd ${JSON.stringify(target)}, pnpm install, pnpm typecheck, pnpm build.\nNative behavior requires a Roku device; this command performs no install or deployment.`,
  );
}
