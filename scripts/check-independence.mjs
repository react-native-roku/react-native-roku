import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";
const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json")));
const registered = new Set([
  manifest.name,
  ...Object.keys(manifest.dependencies),
  ...Object.keys(manifest.peerDependencies),
  ...Object.keys(manifest.devDependencies),
]);
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
assert.ok(tracked.includes("package.json"), "Run from a standalone source checkout");
const inside = (file) => {
  const name = relative(root, file);
  return name !== ".." && !name.startsWith("../") && !isAbsolute(name);
};
for (const file of tracked) {
  const path = resolve(root, file);
  assert.ok(inside(realpathSync(path)), file + " points outside the project");
  const source = readFileSync(path);
  if (source.includes(0)) continue;
  const text = source.toString();
  assert.doesNotMatch(
    text,
    /\/(?:Users|home)\/[a-zA-Z0-9_.-]+\/(?:repos|projects|worktrees)\//,
    file + " contains a developer checkout path",
  );
  if (file.endsWith("pnpm-lock.yaml"))
    for (const m of text.matchAll(/\btarball:\s*['"]?([^\s,'"}]+)/g)) {
      const link = m[1];
      assert.ok(
        link === "file:../runtime.tgz" || link.startsWith("https://registry.npmjs.org/"),
        file + " unexpected package origin: " + link,
      );
    }
  if (!/\.[mc]?[jt]sx?$/.test(file)) continue;
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  function visit(node) {
    const spec =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(node.expression) && node.expression.text === "require"))
          ? node.arguments[0]
          : null;
    if (spec && ts.isStringLiteral(spec)) {
      const value = spec.text;
      if (value.startsWith(".") || isAbsolute(value) || value.startsWith("file:")) {
        assert.ok(
          !isAbsolute(value) && !value.startsWith("file:") && inside(resolve(dirname(path), value)),
          file + " imports " + value,
        );
      } else if (file.startsWith("src/") && !file.includes(".test.") && !isBuiltin(value)) {
        const name = value
          .split("/")
          .slice(0, value.startsWith("@") ? 2 : 1)
          .join("/");
        assert.ok(registered.has(name), file + " imports undeclared package " + name);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
const registry = JSON.parse(readFileSync(resolve(root, "compatibility/registry.json")));
const coverage = Object.entries(registry.modules).flatMap(([name, module]) =>
  Object.entries(module.exports).map(([api, details]) => {
    const contracts = details.contracts ?? module.contracts;
    const tests = [
      ...new Set(
        contracts.flatMap((id) => {
          assert.ok(registry.contracts[id], id);
          return registry.contracts[id].tests;
        }),
      ),
    ];
    for (const proof of tests) assert.ok(existsSync(resolve(root, proof.split("#")[0])), proof);
    return { module: name, api, contracts, contractEvidence: tests, device: module.device };
  }),
);
if (process.argv.includes("--coverage")) console.log(JSON.stringify(coverage, null, 2));
else
  console.log(JSON.stringify({ tracked: tracked.length, classifiedApiEntries: coverage.length }));
