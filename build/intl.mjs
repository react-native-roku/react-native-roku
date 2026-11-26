import ts from "typescript";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Pure upstream data only. Never evaluate dependency source to extract it. */
function literal(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    const value = -Number(node.operand.text);
    if (!Object.is(value, -0)) return value;
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
  if (ts.isObjectLiteralExpression(node)) {
    const value = Object.create(null);
    for (const property of node.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        !property.name ||
        ts.isComputedPropertyName(property.name)
      )
        throw Error("Nonliteral Intl data property");
      const key =
        ts.isIdentifier(property.name) ||
        ts.isStringLiteralLike(property.name) ||
        ts.isNumericLiteral(property.name)
          ? property.name.text
          : null;
      if (key === null || key === "__proto__" || Object.hasOwn(value, key))
        throw Error("Unsupported Intl data key");
      value[key] = literal(property.initializer);
    }
    return value;
  }
  throw Error("Intl data contains executable source; review the upstream layout");
}

/** Bound SDK per-file transformation work without pruning locales or editing
 * installed dependencies. Every emitted file lives in the build's generation. */
export function prepareIntlDataModules(
  path,
  generatedDirectory,
  { threshold = 64 * 1024, chunkCharacters = 64 * 1024, source: inputSource } = {},
) {
  if (!generatedDirectory) throw Error("An Intl build requires an owned generatedDirectory");
  if (!(
    Number.isSafeInteger(threshold) &&
    threshold > 0 &&
    Number.isSafeInteger(chunkCharacters) &&
    chunkCharacters > 0 &&
    chunkCharacters <= 64 * 1024
  ))
    throw Error("Invalid Intl data chunk bounds");
  const code = inputSource ?? readFileSync(path, "utf8");
  const source = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const replacements = [],
    imports = [],
    files = [];
  const directory = resolve(
    generatedDirectory,
    "intl-data",
    createHash("sha256").update(code).digest("hex").slice(0, 20),
  );
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const node = declaration.initializer;
      if (!node || node.end - node.getStart(source) < threshold) continue;
      let data;
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === "JSON.parse" &&
        node.arguments.length === 1 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        data = node.arguments[0].text;
        JSON.parse(data);
      } else if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node))
        data = JSON.stringify(literal(node));
      else throw Error(`Review large Intl initializer ${declaration.name.getText(source)}`);
      mkdirSync(directory, { recursive: true });
      const index = replacements.length,
        fragments = [];
      for (let offset = 0; offset < data.length; offset += chunkCharacters) {
        const part = resolve(directory, `data-${index}-${fragments.length}.mjs`);
        writeFileSync(
          part,
          `export default ${JSON.stringify(data.slice(offset, offset + chunkCharacters))};\n`,
        );
        files.push(part);
        fragments.push(part);
      }
      const driver = resolve(directory, `data-${index}.mjs`);
      writeFileSync(
        driver,
        fragments.map((part, n) => `import part${n} from ${JSON.stringify(part)};`).join("\n") +
          `\nexport default JSON.parse([${fragments.map((_, n) => `part${n}`).join(",")}].join(""));\n`,
      );
      files.push(driver);
      const name = `__rnrIntlData${index}`;
      if (code.includes(name)) throw Error("Intl extraction name collision");
      imports.push(`import ${name} from ${JSON.stringify(driver)};`);
      replacements.push({ start: node.getStart(source), end: node.end, value: name });
    }
  }
  if (!replacements.length && code.length > 2 * 1024 * 1024)
    throw Error("Review changed Intl static data layout before SDK transformation");
  let contents = code;
  for (const replacement of replacements.toReversed())
    contents =
      contents.slice(0, replacement.start) + replacement.value + contents.slice(replacement.end);
  return { contents: imports.join("\n") + "\n" + contents, files };
}
