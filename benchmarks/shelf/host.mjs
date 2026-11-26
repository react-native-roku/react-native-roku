import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const [workspacePath, outputPath, workload = "catalog"] = process.argv.slice(2);
assert.ok(
  workspacePath && outputPath && ["catalog", "shelf"].includes(workload),
  "Usage: node host.mjs PREPARED_WORKSPACE NEW_OUTPUT [catalog|shelf]",
);
const workspace = resolve(workspacePath);
const consumer = resolve(workspace, "react");
const archive = resolve(workspace, "runtime.tgz");
const output = resolve(outputPath);
mkdirSync(output, { mode: 0o700 });
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const archiveSha256 = sha256(readFileSync(archive));
assert.equal(
  archiveSha256,
  JSON.parse(readFileSync(resolve(workspace, "inputs.json"))).archiveSha256,
);
const require = createRequire(resolve(consumer, "package.json"));
const runtime = realpathSync(dirname(require.resolve("react-native-roku/package.json")));
const archiveDir = resolve(output, "archive");
mkdirSync(archiveDir);
execFileSync("tar", ["-xf", archive, "-C", archiveDir]);
const packageDir = resolve(archiveDir, "package");
const verify = (path) => {
  const installed = realpathSync(path);
  assert.ok(installed.startsWith(runtime + sep), installed);
  assert.deepEqual(
    readFileSync(installed),
    readFileSync(resolve(packageDir, installed.slice(runtime.length + 1))),
    installed,
  );
};
const pluginPath = resolve(runtime, "build/esbuild.mjs");
verify(pluginPath);
const { build } = require("esbuild");
const { rokuPlugin } = await import(pathToFileURL(pluginPath));
const source = readFileSync(
  resolve(
    import.meta.dirname,
    workload === "shelf" ? "host-shelf.mjs" : "../../scripts/host-performance-workload.mjs",
  ),
  "utf8",
);

function replaceOnce(code, before, after) {
  assert.equal(code.split(before).length, 2, "Host instrumentation anchor changed: " + before);
  return code.replace(before, after);
}

// Structural reads run in a separate program. Neither the source archive nor
// the timed bundle is instrumented.
let diagnosticSource = source;
if (workload === "catalog") {
  diagnosticSource = replaceOnce(
    source,
    "      yogaNodes: 0,",
    "      yogaNodes: 0,\n      fieldCandidates: 0,\n      fieldVisits: 0,",
  );
  diagnosticSource = replaceOnce(
    diagnosticSource,
    '"layoutCalls", "yogaNodes"]',
    '"layoutCalls", "yogaNodes", "fieldCandidates", "fieldVisits"]',
  );
  diagnosticSource = replaceOnce(
    diagnosticSource,
    "entry.layoutCalls, entry.yogaNodes]",
    "entry.layoutCalls, entry.yogaNodes, entry.fieldCandidates, entry.fieldVisits]",
  );
}
const shelfFixture = {
  name: "host-shelf-fixture",
  setup(builder) {
    builder.onResolve({ filter: /^shelf-benchmark-score$/ }, () => ({
      path: resolve(import.meta.dirname, "score.mjs"),
    }));
    builder.onLoad({ filter: /[/\\]src[/\\]App\.tsx$/ }, ({ path }) => ({
      contents: replaceOnce(
        readFileSync(path, "utf8"),
        '            console.log("SHELF_FOCUS", tile.id, performance.now());\n',
        "",
      ),
      loader: "tsx",
      resolveDir: dirname(path),
    }));
  },
};
const shelfStructure = {
  name: "host-shelf-layout",
  setup(builder) {
    builder.onLoad(
      { filter: /(?:createNativeRoot|flexLayout|nativeNodeFields)\.ts$/ },
      ({ path }) => {
        verify(path);
        let code = readFileSync(path, "utf8");
        const probe = "globalThis.__SHELF_STRUCTURE__";
        if (path.endsWith("createNativeRoot.ts")) {
          const layout = "        const layout = reuse\n";
          code = replaceOnce(
            code,
            layout,
            `        if (${probe} && layoutCache) {
          const old = new Map(layoutCache.dependencies.map((item) => [item.element, item]));
          for (const [element, input] of entries) {
            const previous = old.get(element);
            if (!previous) continue;
            const styleChanged = !sameLayoutStyle(input.style, previous.style, element.type === "group");
            const textChanged = previous.text !== input.text;
            if (styleChanged || textChanged) ${probe}.dependencies.push({
              id: element.props.layout?.id, styleChanged, textChanged,
              before: previous.text, after: input.text
            });
          }
        }
${layout}`,
          );
          const measure = "              const element = elements.get(input)!;";
          code = replaceOnce(
            code,
            measure,
            `${measure}
              ${probe}?.geometryMeasures.push({ id: element.props.layout?.id, text: input.text, width });`,
          );
          const capture = "        const reusedRectangles =";
          code = replaceOnce(
            code,
            capture,
            `        if (${probe} && layout && layoutCache) {
          for (const [element, input] of entries) {
            const before = layoutCache.rectangles.get(element);
            const after = layout.get(input);
            if (before && after && Object.keys(before).some((axis) => before[axis] !== after[axis]))
              ${probe}.boundsChanges.push({ id: element.props.layout?.id, before, after });
          }
        }
${capture}`,
          );
          let visit = "          parentVisible = true,\n        ) => {";
          if (code.includes("if (visited && !visited.has(entry)) return;"))
            visit += "\n          if (visited && !visited.has(entry)) return;";
          code = replaceOnce(
            code,
            visit,
            `${visit}\n          if (${probe}) ${probe}.placementVisits++;`,
          );
        } else if (path.endsWith("flexLayout.ts")) {
          const solve =
            "root.calculateLayout(viewport.width, viewport.height, Yoga.DIRECTION_LTR);";
          assert.equal(code.split(solve).length, 3, "Expected ordinary and percentage Yoga solves");
          code = code.replaceAll(solve, `if (${probe}) ${probe}.geometrySolves++;\n    ${solve}`);
          const read = "        const layout = node.getComputedLayout();";
          code = replaceOnce(
            code,
            read,
            `${read}\n        if (${probe}) ${probe}.rectangleReads++;`,
          );
        } else {
          const measure = '  if (node.type === "label") {';
          code = replaceOnce(
            code,
            measure,
            `${measure}
    ${probe}?.fieldMeasures.push({ id: node.props.layout?.id, text: labelText(node), width: rect.width });`,
          );
        }
        return { contents: code, loader: "ts", resolveDir: dirname(path) };
      },
    );
  },
};
const instrument = {
  name: "shelf-host-counters",
  setup(builder) {
    builder.onLoad({ filter: /(?:flexLayout|SceneRoot)\.ts$/ }, ({ path }) => {
      verify(path);
      let code = readFileSync(path, "utf8");
      const increment = (field) =>
        `if (globalThis.__HOST_PERF_COUNTS__) globalThis.__HOST_PERF_COUNTS__.${field}++;`;
      if (path.endsWith("flexLayout.ts")) {
        const signature = "): Map<LayoutInput, LayoutRect> {";
        code = replaceOnce(code, signature, signature + "\n  " + increment("layoutCalls"));
        const allocation = "Yoga.Node.createWithConfig(config)";
        assert.ok(code.includes(allocation));
        code = code.replaceAll(
          allocation,
          `(globalThis.__HOST_PERF_COUNTS__ && globalThis.__HOST_PERF_COUNTS__.yogaNodes++, ${allocation})`,
        );
      } else {
        const legacyCommit = "resetAfterCommit: (root) => root.commit(true),";
        if (code.includes(legacyCommit))
          code = replaceOnce(
            code,
            legacyCommit,
            `resetAfterCommit: (root) => { ${increment("reactCommits")} root.commit(true); },`,
          );
        else {
          const commitHook = "resetAfterCommit(root) {";
          code = replaceOnce(code, commitHook, commitHook + increment("reactCommits"));
          const stableSubmit = "  if (affected.length)\n    root.port.batch";
          code = replaceOnce(code, stableSubmit, increment("treeCommits") + "\n" + stableSubmit);
        }
        const fullSubmit = "const { port } = root;\n  const realized";
        code = replaceOnce(code, fullSubmit, increment("treeCommits") + "\n" + fullSubmit);
        const visit = "const authored = child.props.fields;";
        code = replaceOnce(code, visit, increment("fieldVisits") + " " + visit);
        const materialize = "fields = resolveReferences(inputs)";
        code = replaceOnce(code, materialize, increment("fieldCandidates") + " " + materialize);
      }
      return { contents: code, loader: "ts", resolveDir: dirname(path) };
    });
  },
};

const result = {
  archiveSha256,
  workloadSha256: sha256(source),
  ...(workload === "shelf"
    ? { fixtureSha256: sha256(readFileSync(resolve(consumer, "src/App.tsx"))) }
    : {}),
  esbuildVersion: require("esbuild/package.json").version,
  node: process.version,
};
for (const diagnostic of [true, false]) {
  const label = diagnostic ? "structure" : "timing";
  const outfile = resolve(output, label + ".cjs");
  const { metafile } = await build({
    absWorkingDir: consumer,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node24",
    stdin: {
      contents: diagnostic ? diagnosticSource : source,
      resolveDir: consumer,
      loader: "js",
    },
    outfile,
    define: { "process.env.NODE_ENV": '"production"', __DEV__: "false" },
    plugins: [
      ...(workload === "shelf"
        ? [shelfFixture, ...(diagnostic ? [shelfStructure] : [])]
        : diagnostic
          ? [instrument]
          : []),
      rokuPlugin({ root: consumer }),
    ],
    metafile: true,
  });
  const inputs = Object.keys(metafile.inputs)
    .map((file) => resolve(consumer, file))
    .filter(
      (file) =>
        file.startsWith(resolve(consumer, "node_modules/react-native-roku") + sep) ||
        file.startsWith(runtime + sep),
    );
  assert.ok(inputs.length > 10, "Expected to bundle the packed renderer");
  inputs.forEach(verify);
  const readings = resolve(output, label + ".json");
  execFileSync(process.execPath, ["--expose-gc", outfile, readings], {
    timeout: 65000,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST_PERF_DIAGNOSTIC: diagnostic ? "1" : "0",
      HOST_PERF_NO_COUNTERS: "0",
    },
  });
  const report = JSON.parse(readFileSync(readings, "utf8"));
  if (workload === "shelf") {
    result[label] = report.results.map(({ titleWorkload, summary }) => ({
      titleWorkload,
      ...summary,
    }));
    continue;
  }
  assert.ok(report.cleanup.allPassed);
  result[label] = report.results
    .filter((row) => row.workload === "focus-style")
    .map((row) => {
      const { cards, round, medianMs, p95Ms, maxMs } = row;
      if (!diagnostic) return { cards, round, medianMs, p95Ms, maxMs };
      return {
        cards,
        round,
        samples: row.raw.map((values) =>
          Object.fromEntries(
            ["fieldCandidates", "fieldVisits", "set", "layoutCalls", "yogaNodes"].map((field) => [
              field,
              values[row.columns.indexOf(field)],
            ]),
          ),
        ),
      };
    });
}
writeFileSync(resolve(output, "summary.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
