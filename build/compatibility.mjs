import { readFileSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import ts from "typescript";
import { createHash } from "node:crypto";

export const compatibility = JSON.parse(
  readFileSync(new URL("../compatibility/registry.json", import.meta.url)),
);
export function discoverAdapterSurface(root, modules = compatibility.modules) {
  const entries = Object.values(modules).map((module) => resolve(root, module.source));
  const program = ts.createProgram(entries, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    skipLibCheck: true,
    esModuleInterop: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker(),
    result = {};
  for (const [name, module] of Object.entries(modules)) {
    const source = program.getSourceFile(resolve(root, module.source));
    const symbol = source && checker.getSymbolAtLocation(source);
    if (!symbol) throw Error(`Cannot inspect adapter ${name}`);
    const exports = {};
    for (let item of checker.getExportsOfModule(symbol)) {
      const exportName = item.name;
      if (item.flags & ts.SymbolFlags.Alias) item = checker.getAliasedSymbol(item);
      if (!(item.flags & ts.SymbolFlags.Value)) continue;
      const declaration = item.valueDeclaration ?? item.declarations?.[0] ?? source;
      const type = checker.getTypeOfSymbolAtLocation(item, declaration);
      const members = checker
        .getPropertiesOfType(type)
        .map((member) => member.name)
        .filter(
          (value) =>
            !value.startsWith("__") &&
            !["prototype", "displayName", "defaultProps", "propTypes", "$$typeof"].includes(value),
        )
        .sort();
      const props = new Set();
      let openProps = false;
      if (/^[A-Z]/.test(exportName))
        for (const signature of type.getCallSignatures()) {
          const parameter = signature.parameters[0];
          if (parameter) {
            const propsType = checker.getTypeOfSymbolAtLocation(parameter, declaration);
            openProps ||= Boolean(propsType.getStringIndexType());
            for (const prop of checker.getPropertiesOfType(propsType)) props.add(prop.name);
          }
        }
      exports[exportName] = { members, props: [...props].sort(), openProps };
    }
    result[name] = Object.fromEntries(
      Object.entries(exports).sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  return result;
}
/** Inventory the actual bundled source graph. Spreads/dynamic access remain explicit review evidence. */
export function auditCompatibility({
  root,
  files,
  libraries = {},
  sourceOnly = true,
  workspacePrefixes = [],
}) {
  const violations = [],
    imports = [],
    dynamic = [],
    namespaces = new Map();
  const known = compatibility.modules;
  const issue = (file, line, message, suppliedContext) => {
    const path = relative(root, file),
      context = suppliedContext ?? readFileSync(file, "utf8").split("\n")[line - 1]?.trim() ?? "";
    violations.push({
      id: createHash("sha256").update([path, message, context].join("\n")).digest("hex"),
      file: path,
      line,
      message,
      context,
    });
  };
  for (const path of files) {
    const file = resolve(root, path);
    if (
      !/\.[cm]?[jt]sx?$/.test(file) ||
      !existsSync(file) ||
      (sourceOnly && file.split(/[\\/]/).includes("node_modules"))
    )
      continue;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const bindings = new Map();
    namespaces.clear();
    const record = (specifier, names, line) => {
      const module = known[specifier];
      if (!module) {
        if (
          specifier.startsWith(".") ||
          specifier.startsWith("/") ||
          workspacePrefixes.some((prefix) => specifier.startsWith(prefix)) ||
          specifier === "react-native-roku" ||
          specifier.startsWith("react-native-roku/")
        )
          return;
        const packageName = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0];
        if (!libraries[specifier] && !libraries[packageName])
          issue(file, line, `Unreviewed library ${specifier}; add a versioned consumer contract`);
        const library = libraries[specifier] ?? libraries[packageName];
        if (library?.imports)
          for (const name of names)
            if (!library.imports.includes(name))
              issue(file, line, `Unreviewed library API ${specifier}.${name}`);
        imports.push({
          file: relative(root, file),
          line,
          module: specifier,
          names,
          kind: "library",
        });
        return;
      }
      imports.push({ file: relative(root, file), line, module: specifier, names, kind: "adapter" });
      for (const name of names) {
        if (name === "*") continue;
        const api = module.exports[name];
        if (!api) issue(file, line, `${specifier}.${name} has no registered Roku contract`);
        else if (["unsupported", "review-required"].includes(api.status))
          issue(
            file,
            line,
            `${specifier}.${name} is ${api.status}: ${api.limitations ?? module.limitations}`,
          );
      }
    };
    for (const node of source.statements) {
      if (
        !ts.isImportDeclaration(node) ||
        !ts.isStringLiteralLike(node.moduleSpecifier) ||
        node.importClause?.isTypeOnly
      )
        continue;
      const specifier = node.moduleSpecifier.text,
        clause = node.importClause,
        names = [];
      if (clause?.name) {
        names.push("default");
        bindings.set(clause.name.text, { specifier, name: "default" });
      }
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          names.push("*");
          namespaces.set(clause.namedBindings.name.text, specifier);
        } else
          for (const item of clause.namedBindings.elements)
            if (!item.isTypeOnly) {
              const name = item.propertyName?.text ?? item.name.text;
              names.push(name);
              bindings.set(item.name.text, { specifier, name });
            }
      }
      record(specifier, names, source.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    const visit = (node) => {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      if (
        ts.isExportDeclaration(node) &&
        !node.isTypeOnly &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        const names =
          node.exportClause && ts.isNamedExports(node.exportClause)
            ? node.exportClause.elements
                .filter((item) => !item.isTypeOnly)
                .map((item) => item.propertyName?.text ?? item.name.text)
            : ["*"];
        record(node.moduleSpecifier.text, names, line);
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        const value = node.arguments[0];
        if (value && ts.isStringLiteralLike(value)) {
          const parent = node.parent;
          const names =
            ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)
              ? parent.name.elements.map((item) => {
                  const name = item.propertyName?.getText(source) ?? item.name.getText(source);
                  bindings.set(item.name.getText(source), { specifier: value.text, name });
                  return name;
                })
              : ["*"];
          if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
            namespaces.set(parent.name.text, value.text);
          record(value.text, names, line);
        } else dynamic.push({ file: relative(root, file), line, kind: "nonliteral-module" });
      }
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        const namespace = namespaces.get(node.expression.text);
        if (namespace) record(namespace, [node.name.text], line);
        const binding = bindings.get(node.expression.text),
          api = binding && known[binding.specifier]?.exports[binding.name];
        if (api?.members.length && !api.members.includes(node.name.text))
          issue(
            file,
            line,
            `${binding.specifier}.${binding.name}.${node.name.text} has no registered member contract`,
          );
      }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const binding = bindings.get(node.tagName.getText(source));
        const api = binding && known[binding.specifier]?.exports[binding.name];
        if (api?.props.length)
          for (const attribute of node.attributes.properties) {
            if (ts.isJsxSpreadAttribute(attribute))
              dynamic.push({
                file: relative(root, file),
                line,
                kind: "spread-props",
                api: binding.name,
              });
            else if (
              !api.openProps &&
              !["key", "ref"].includes(attribute.name.text) &&
              !api.props.includes(attribute.name.text)
            )
              issue(
                file,
                line,
                `${binding.specifier}.${binding.name} prop ${attribute.name.text} has no registered contract`,
                attribute.getText(source).replace(/\s+/g, " "),
              );
          }
      }
      if (
        ts.isElementAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        (bindings.has(node.expression.text) || namespaces.has(node.expression.text))
      ) {
        const namespace = namespaces.get(node.expression.text);
        if (namespace && ts.isStringLiteralLike(node.argumentExpression))
          record(namespace, [node.argumentExpression.text], line);
        else dynamic.push({ file: relative(root, file), line, kind: "computed-api-access" });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return {
    schema: "react-native-roku-import-audit/v1",
    status: violations.length ? "failed" : "passed",
    deviceQualified: false,
    imports,
    dynamic,
    violations,
    limitations: [
      "Literal import/member/JSX checks; computed access and spread props require behavioral contracts",
      "An exported type surface does not establish that every prop or method is implemented",
    ],
  };
}
