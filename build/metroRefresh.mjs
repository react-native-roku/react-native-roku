import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { refreshSourceMaps } from "./refreshSourceMap.mjs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const inside = (parent, path) => {
  const child = relative(parent, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(".." + sep));
};

/** Shared bootstrap owner for standalone and custom consumer previews. */
export function writeRokuRefreshBootstrap({ root = process.cwd(), session, generation, outfile }) {
  if (
    !session?.id ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    typeof outfile !== "string"
  )
    throw Error("A Roku refresh bootstrap requires a session, generation and outfile");
  root = resolve(root);
  outfile = resolve(root, outfile);
  const require = createRequire(resolve(root, "package.json"));
  mkdirSync(dirname(outfile), { recursive: true });
  writeFileSync(
    outfile,
    `import Refresh from ${JSON.stringify(require.resolve("react-refresh/runtime"))};import {installRokuRefreshRuntime} from ${JSON.stringify(fileURLToPath(new URL("./refreshRuntime.mjs", import.meta.url)))};installRokuRefreshRuntime(Refresh,${JSON.stringify({ sessionId: session.id, generation })});\n`,
  );
  return outfile;
}

/** Inspect original source, before Babel helpers/registration are inserted.
 * React and StyleSheet wrappers are allocations with known lifetimes. Unknown
 * top-level calls, stores, contexts and resource constructors need a remount. */
export function isRefreshSafeSource(path, contents) {
  const source = ts.createSourceFile(
    path,
    contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  if (source.parseDiagnostics.length) return false;
  const react = new Set(),
    wrappers = new Set(),
    styles = new Set();
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const module = node.moduleSpecifier.text,
      clause = node.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (module === "react" && clause.name) react.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings) && module === "react")
      react.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings))
      for (const item of bindings.elements) {
        if (item.isTypeOnly) continue;
        const name = (item.propertyName ?? item.name).text;
        if (module === "react" && ["memo", "forwardRef"].includes(name))
          wrappers.add(item.name.text);
        if (
          ["react-native", "react-native-roku/react-native"].includes(module) &&
          name === "StyleSheet"
        )
          styles.add(item.name.text);
      }
  }
  const isWrapper = (call) =>
    (ts.isIdentifier(call) && wrappers.has(call.text)) ||
    (ts.isPropertyAccessExpression(call) &&
      ts.isIdentifier(call.expression) &&
      react.has(call.expression.text) &&
      ["memo", "forwardRef"].includes(call.name.text));
  const ownedComponents = new Set();
  for (const node of source.statements) {
    if (ts.isFunctionDeclaration(node) && node.name) ownedComponents.add(node.name.text);
    if (ts.isVariableStatement(node))
      for (const declaration of node.declarationList.declarations) {
        const value = declaration.initializer;
        if (
          ts.isIdentifier(declaration.name) &&
          value &&
          (ts.isArrowFunction(value) ||
            ts.isFunctionExpression(value) ||
            (ts.isCallExpression(value) && isWrapper(value.expression)))
        )
          ownedComponents.add(declaration.name.text);
      }
  }
  const pure = (node) => {
    if (!node) return true;
    if (
      ts.isIdentifier(node) ||
      ts.isLiteralExpression(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(
        node.kind,
      ) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node)
    )
      return true;
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node)
    )
      return pure(node.expression);
    if (ts.isPrefixUnaryExpression(node))
      return (
        [
          ts.SyntaxKind.PlusToken,
          ts.SyntaxKind.MinusToken,
          ts.SyntaxKind.ExclamationToken,
          ts.SyntaxKind.TildeToken,
        ].includes(node.operator) && pure(node.operand)
      );
    if (ts.isPropertyAccessExpression(node)) return pure(node.expression);
    if (ts.isArrayLiteralExpression(node)) return node.elements.every(pure);
    if (ts.isObjectLiteralExpression(node))
      return node.properties.every(
        (property) =>
          ts.isShorthandPropertyAssignment(property) ||
          ts.isMethodDeclaration(property) ||
          (ts.isPropertyAssignment(property) &&
            !ts.isComputedPropertyName(property.name) &&
            pure(property.initializer)),
      );
    if (ts.isCallExpression(node)) {
      const call = node.expression;
      const known =
        isWrapper(call) ||
        (ts.isPropertyAccessExpression(call) &&
          ts.isIdentifier(call.expression) &&
          styles.has(call.expression.text) &&
          call.name.text === "create");
      return known && node.arguments.every(pure);
    }
    return false;
  };
  return source.statements.every((node) => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isEmptyStatement(node)
    )
      return true;
    if (ts.isExpressionStatement(node)) {
      const value = node.expression;
      if (ts.isStringLiteral(value)) return true;
      // Conventional display names mutate only a freshly allocated local
      // function/React wrapper. Imported objects, aliases and other assignments
      // can affect resource lifetimes and still require a full reload.
      return (
        ts.isBinaryExpression(value) &&
        value.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(value.left) &&
        ts.isIdentifier(value.left.expression) &&
        ownedComponents.has(value.left.expression.text) &&
        value.left.name.text === "displayName" &&
        ts.isStringLiteral(value.right)
      );
    }
    if (ts.isVariableStatement(node))
      return node.declarationList.declarations.every((item) => pure(item.initializer));
    if (ts.isExportAssignment(node)) return pure(node.expression);
    return false;
  });
}

/** A session owns stable Metro IDs and only advances its base on publication. */
export function createRokuMetroRefreshSession({
  root = process.cwd(),
  directory,
  sourceRoots = [root],
}) {
  root = resolve(root);
  if (!directory) throw Error("A refresh session requires an owned directory");
  directory = resolve(root, directory);
  const id = randomUUID(),
    candidates = new Map(),
    purity = new Map();
  let assign,
    base,
    disposed = false;
  const active = () => {
    if (disposed) throw Error("The Roku refresh session is retired");
  };
  const session = {
    id,
    directory,
    createModuleIdFactory(original) {
      active();
      assign ??= original();
      return () => assign;
    },
    classify(path, source) {
      if (
        !source ||
        !/\.[cm]?[jt]sx?$/.test(path) ||
        !sourceRoots.some((parent) => {
          const base = resolve(root, parent);
          return (
            inside(base, path) &&
            !relative(base, path)
              .split(/[\\/]/)
              .some((part) => ["node_modules", ".roku", ".local", "generated"].includes(part))
          );
        })
      )
        return false;
      const key = path + sha(source);
      if (!purity.has(key)) purity.set(key, isRefreshSafeSource(path, source));
      return purity.get(key);
    },
    stage({ generation, graph, identity, outputDirectory }) {
      active();
      if (
        !Number.isSafeInteger(generation) ||
        generation < 1 ||
        graph.sessionId !== id ||
        graph.generation !== generation
      )
        throw Error("Invalid Roku refresh generation");
      let reason = !base
        ? "initial-generation"
        : base.generation !== generation - 1
          ? "publication-gap"
          : base.identity !== identity
            ? "configuration-assets-or-runtime-changed"
            : base.graph.runtimeSha256 !== graph.runtimeSha256 ||
                base.graph.bootstrapSha256 !== graph.bootstrapSha256 ||
                JSON.stringify(base.graph.bindings) !== JSON.stringify(graph.bindings)
              ? "metro-startup-changed"
              : null;
      const previous = new Map((base?.graph.modules ?? []).map((module) => [module.id, module]));
      const current = new Map(graph.modules.map((module) => [module.id, module]));
      if (
        !reason &&
        (previous.size !== current.size ||
          graph.modules.some((module) => previous.get(module.id)?.source !== module.source))
      )
        reason = "dependency-graph-changed";
      const changed = graph.modules.filter(
        (module) => previous.get(module.id)?.sha256 !== module.sha256,
      );
      if (!reason && changed.some((module) => !module.safe || !previous.get(module.id)?.safe))
        reason = "resource-lifetime-changed";
      let plan = { type: "reload", reason, sessionId: id, generation };
      if (!reason) {
        const inverse = Object.fromEntries(graph.modules.map((module) => [module.id, []]));
        for (const module of graph.modules)
          for (const dependency of module.dependencies) {
            if (!Object.hasOwn(inverse, dependency))
              throw Error("Unattested Metro refresh dependency");
            inverse[dependency].push(module.id);
          }
        const updateId = sha(
          JSON.stringify([id, base.generation, generation, changed.map((module) => module.sha256)]),
        );
        const prefix = `export function apply(){const __rnrRefresh=globalThis.__RNR_ROKU_REFRESH__;const {${graph.bindings.join(",")}}=__rnrRefresh.beginPatch(${JSON.stringify({ sessionId: id, fromGeneration: base.generation, generation, updateId })});\n`;
        const suffix = "\n}\n";
        const chunks = [];
        const sourceMap = refreshSourceMaps(graph);
        const limit = graph.maxModuleBytes - (sourceMap ? 256 : 0);
        let chunk = prefix;
        let parts = [];
        for (const module of changed) {
          const code = module.code.replace(/\);\s*$/, "," + JSON.stringify(inverse) + ");") + "\n";
          if (Buffer.byteLength(prefix + code + suffix) > limit) {
            reason = "refresh-factory-exceeds-budget";
            break;
          }
          if (Buffer.byteLength(chunk + code + suffix) > limit) {
            chunks.push({ contents: chunk + suffix, parts });
            chunk = prefix;
            parts = [];
          }
          parts.push({ module, line: chunk.split("\n").length });
          chunk += code;
        }
        chunks.push({ contents: chunk + suffix, parts });
        const target = resolve(outputDirectory, "refresh");
        mkdirSync(target, { recursive: true });
        const paths = reason
          ? []
          : chunks.map(({ contents, parts }, index) => {
              const name = `update-${updateId}-${index}.mjs`;
              if (sourceMap) {
                writeFileSync(resolve(target, name + ".map"), sourceMap(name, parts));
                contents += `\n//# sourceMappingURL=${name}.map\n`;
              }
              if (Buffer.byteLength(contents) > graph.maxModuleBytes)
                throw Error("Metro refresh module exceeds its budget");
              writeFileSync(resolve(target, name), contents);
              return "/refresh/" + name;
            });
        plan = reason
          ? { ...plan, reason }
          : {
              type: "refresh",
              sessionId: id,
              fromGeneration: base.generation,
              generation,
              updateId,
              paths,
              moduleIds: changed.map((module) => module.id),
              changed: changed.map((module) => module.source),
            };
      }
      candidates.set(generation, { generation, graph, identity, plan });
      return plan;
    },
    plan(generation) {
      active();
      return candidates.get(generation)?.plan ?? null;
    },
    discard(generation) {
      active();
      candidates.delete(generation);
    },
    publish(generation) {
      active();
      const candidate = candidates.get(generation);
      if (!candidate || (base && generation <= base.generation))
        throw Error("Unprepared Roku refresh publication");
      base = candidate;
      candidates.clear();
    },
    dispose() {
      disposed = true;
      candidates.clear();
      purity.clear();
      base = assign = null;
    },
  };
  return session;
}
