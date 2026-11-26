import ts from "typescript";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { GenMapping, addMapping, setSourceContent, toEncodedMap } from "@jridgewell/gen-mapping";
import { TraceMap, eachMapping } from "@jridgewell/trace-mapping";
import { rokuBuildProfile } from "./environment.mjs";
import { Script } from "node:vm";

/** Preserve Metro's module factories/require cache while bounding SDK inputs.
 * Unknown serializer shapes fail before writing, rather than moving executable
 * statements across lexical or lifetime boundaries. */
export function writeMetroModules({
  code,
  map,
  mapUrl,
  outfile,
  exports: names = ["mountApplication"],
  entryModuleId,
  profile,
  metadata,
  maxModuleBytes = 2 * 1024 * 1024,
  refresh,
  refreshMap,
}) {
  if (!Number.isSafeInteger(maxModuleBytes) || maxModuleBytes <= 0)
    throw Error("Invalid Metro module budget");
  const reserved = new Set([
    "default",
    "eval",
    "arguments",
    "__r",
    "class",
    "const",
    "let",
    "var",
    "function",
    "import",
    "export",
    "return",
    "await",
    "yield",
    "delete",
    "new",
    "this",
    "super",
    "null",
    "true",
    "false",
    "if",
    "else",
    "for",
    "while",
    "switch",
    "case",
    "throw",
    "try",
    "catch",
    "finally",
    "break",
    "continue",
    "do",
    "in",
    "instanceof",
    "typeof",
    "void",
    "with",
    "debugger",
    "extends",
    "enum",
    "implements",
    "interface",
    "package",
    "private",
    "protected",
    "public",
    "static",
  ]);
  if (
    !Array.isArray(names) ||
    !names.length ||
    new Set(names).size !== names.length ||
    names.some(
      (name) =>
        typeof name !== "string" ||
        !/^[A-Za-z_$][\w$]*$/.test(name) ||
        reserved.has(name) ||
        name.startsWith("__rnr"),
    )
  )
    throw Error("Metro frontend exports need distinct supported identifiers");
  // TypeScript's syntax parser accepts ESM declarations inside functions.
  // Metro factories must already be executable scripts. Parse without running
  // any application code before creating a generation or its output files.
  try {
    new Script(code, { filename: "metro.bundle.js" });
  } catch (cause) {
    throw Error("Review invalid Metro bundle serialization before partitioning", { cause });
  }
  const source = ts.createSourceFile(
    "metro.js",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const refuse = () => {
    throw Error("Review changed Metro bundle serialization before partitioning");
  };
  if (source.parseDiagnostics.length) refuse();
  const call = (node, name) =>
    ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === name;
  const statements = [...source.statements];
  const first = statements.findIndex((node) => call(node, "__d"));
  if (first < 1) refuse();
  const footerIndex = statements.findIndex((node, index) => index > first && !call(node, "__d"));
  if (
    footerIndex < 0 ||
    statements
      .slice(footerIndex)
      .some((node) => !call(node, "__r") || node.expression.arguments.length !== 1)
  )
    refuse();
  const definitions = statements.slice(first, footerIndex);
  for (const node of definitions)
    if (
      node.expression.arguments.length < 3 ||
      !ts.isFunctionExpression(node.expression.arguments[0])
    )
      refuse();
  const footer = statements.slice(footerIndex);
  const id = footer.at(-1).expression.arguments[0];
  if (!ts.isNumericLiteral(id) && !ts.isStringLiteral(id)) refuse();
  const actualId = ts.isNumericLiteral(id) ? Number(id.text) : id.text;
  if (entryModuleId !== undefined && actualId !== entryModuleId)
    throw Error("Metro entry module differs from the requested entry");
  const bindings = [];
  for (const node of statements.slice(0, first)) {
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) refuse();
        if (
          profile !== undefined &&
          declaration.name.text === "process" &&
          node.declarationList.flags & ts.NodeFlags.Const
        )
          refuse();
        bindings.push(declaration.name.text);
      }
    } else if (ts.isFunctionDeclaration(node) && node.name) bindings.push(node.name.text);
    else if (!ts.isExpressionStatement(node)) refuse();
  }
  if (
    bindings.some((name) => name === "__d" || name === "__r" || reserved.has(name)) ||
    new Set(bindings).size !== bindings.length
  )
    refuse();
  const compilation = profile === undefined ? null : rokuBuildProfile(profile);
  if (compilation && !bindings.includes("process")) refuse();
  const key = createHash("sha256")
    .update(code)
    .update(JSON.stringify(map ?? null))
    .update(JSON.stringify(names))
    .update(JSON.stringify(compilation?.name ?? null))
    .update(String(maxModuleBytes))
    .update(JSON.stringify(refresh ?? null))
    .digest("hex")
    .slice(0, 20);
  const directory = resolve(dirname(outfile), "metro-modules", key);
  const output = [];
  const descriptions = new Map();
  const trace = map ? new TraceMap(map, mapUrl) : null;
  const mappings = [];
  if (trace) eachMapping(trace, (mapping) => mappings.push(mapping));
  const emit = (path, start, end, prefix = "", suffix = "") => {
    const content = prefix + code.slice(start, end) + suffix;
    const mapName = basename(path) + ".map";
    const contents = content + (trace ? `\n//# sourceMappingURL=${mapName}\n` : "\n");
    if (Buffer.byteLength(contents) > maxModuleBytes)
      throw Error(
        `Metro module budget exceeded: ${basename(path)} (${Buffer.byteLength(contents)} bytes)`,
      );
    output.push({ path, contents });
    if (trace) {
      const generated = new GenMapping({ file: basename(path) });
      const first = source.getLineAndCharacterOfPosition(start),
        last = source.getLineAndCharacterOfPosition(end);
      const prefixLines = prefix.split("\n");
      const used = new Set();
      for (const mapping of mappings) {
        const line = mapping.generatedLine - 1,
          column = mapping.generatedColumn;
        if (
          line < first.line ||
          line > last.line ||
          (line === first.line && column < first.character) ||
          (line === last.line && column >= last.character)
        )
          continue;
        const relativeLine = line - first.line;
        const point = {
          line: relativeLine + prefixLines.length,
          column:
            column -
            (relativeLine === 0 ? first.character : 0) +
            (relativeLine === 0 ? prefixLines.at(-1).length : 0),
        };
        if (mapping.source === null) addMapping(generated, { generated: point });
        else {
          used.add(mapping.source);
          addMapping(generated, {
            generated: point,
            original: { line: mapping.originalLine, column: mapping.originalColumn },
            source: mapping.source,
            ...(mapping.name === null ? {} : { name: mapping.name }),
          });
        }
      }
      for (const name of used) {
        const index = trace.resolvedSources.indexOf(name);
        if (trace.sourcesContent?.[index] != null)
          setSourceContent(generated, name, trace.sourcesContent[index]);
      }
      output.push({ path: path + ".map", contents: JSON.stringify(toEncodedMap(generated)) });
    }
  };
  const runtime = resolve(directory, "runtime.mjs");
  if (metadata)
    descriptions.set(runtime, {
      inputs: metadata.scriptInputs(code.slice(0, statements[first].pos)),
      exports: [...bindings, "__d", "__r"],
      imports: [],
    });
  emit(
    runtime,
    0,
    statements[first].pos,
    "",
    `\n${compilation ? `process=Object.assign({},process,{env:Object.assign({},process.env,{NODE_ENV:${JSON.stringify(compilation.name)}})});\n` : ""}const __d=globalThis.__d,__r=globalThis.__r;\n${refresh ? `globalThis.__RNR_ROKU_REFRESH__.attachRuntime(${JSON.stringify(refresh)},{${[...bindings, "__d", "__r"].join(",")}});\n` : ""}export {${[...bindings, "__d", "__r"].join(",")}};\n`,
  );
  const prefix = `import {${[...bindings, "__d"].join(",")}} from './runtime.mjs';\n`;
  const describeModule = (path, start, end) => {
    if (!metadata) return;
    const inputs = {};
    for (const node of definitions.filter((node) => node.pos >= start && node.end <= end)) {
      const id = node.expression.arguments[1];
      if (!ts.isNumericLiteral(id) && !ts.isStringLiteral(id)) refuse();
      const input = metadata.moduleInput(
        ts.isNumericLiteral(id) ? Number(id.text) : id.text,
        Buffer.byteLength(code.slice(node.pos, node.end)),
      );
      if (input)
        inputs[input.path] = {
          bytesInOutput: (inputs[input.path]?.bytesInOutput ?? 0) + input.bytesInOutput,
        };
    }
    descriptions.set(path, {
      inputs,
      imports: [{ path: metadata.outputName(runtime), kind: "import-statement" }],
      exports: [],
    });
  };
  const modules = [];
  let start = definitions[0].pos,
    end = start,
    bytes = Buffer.byteLength(prefix) + 128;
  for (const node of definitions) {
    const size = Buffer.byteLength(code.slice(node.pos, node.end));
    if (bytes + size > maxModuleBytes && end > start) {
      const path = resolve(directory, `module-${modules.length}.mjs`);
      emit(path, start, end, prefix);
      describeModule(path, start, end);
      modules.push(path);
      start = node.pos;
      bytes = Buffer.byteLength(prefix) + 128;
    }
    bytes += size;
    end = node.end;
  }
  const final = resolve(directory, `module-${modules.length}.mjs`);
  emit(final, start, end, prefix);
  describeModule(final, start, end);
  modules.push(final);
  const imports = modules
    .map(
      (path) =>
        `import ${JSON.stringify("./" + relative(dirname(outfile), path).split("\\").join("/"))};`,
    )
    .join("\n");
  const runtimeImport = `import {__r} from ${JSON.stringify("./" + relative(dirname(outfile), runtime).split("\\").join("/"))};\n`;
  const bootstrap =
    imports +
    "\n" +
    runtimeImport +
    footer
      .slice(0, -1)
      .map((node) => node.getText(source))
      .join("\n") +
    `\nconst __rnrMetroEntry=__r(${id.getText(source)});\n` +
    names
      .map((name) => `const ${name}=__rnrMetroEntry[${JSON.stringify(name)}];export {${name}};`)
      .join("\n") +
    "\n";
  if (Buffer.byteLength(bootstrap) > maxModuleBytes)
    throw Error("Metro entry exceeds module budget");
  output.push({ path: resolve(outfile), contents: bootstrap });
  if (metadata)
    descriptions.set(resolve(outfile), {
      inputs: {},
      imports: [...modules, runtime].map((path) => ({
        path: metadata.outputName(path),
        kind: "import-statement",
      })),
      exports: names,
    });
  const metafile = metadata?.metafile(
    Object.fromEntries(
      output.map((file) => [
        metadata.outputName(file.path),
        {
          bytes: Buffer.byteLength(file.contents),
          inputs: {},
          imports: [],
          exports: [],
          ...descriptions.get(file.path),
        },
      ]),
    ),
  );
  let refreshGraph;
  if (refresh) {
    if (
      compilation?.name !== "development" ||
      !metadata?.moduleRefresh ||
      bindings.some((name) => name.startsWith("__rnr"))
    )
      throw Error("Roku refresh requires an attested development Metro graph");
    const literal = (node) => {
      if (ts.isNumericLiteral(node)) return Number(node.text);
      if (ts.isStringLiteral(node)) return node.text;
      throw Error("Review the Metro refresh dependency map");
    };
    refreshGraph = {
      ...refresh,
      bindings: [...bindings, "__d", "__r"],
      maxModuleBytes,
      ...(refreshMap ? { sourceMap: refreshMap } : {}),
      runtimeSha256: createHash("sha256")
        .update(code.slice(0, statements[first].pos))
        .digest("hex"),
      bootstrapSha256: createHash("sha256")
        .update(JSON.stringify([actualId, names, footer.map((node) => node.getText(source))]))
        .digest("hex"),
      modules: definitions.map((node) => {
        const args = node.expression.arguments;
        if (args.length > 4 || !ts.isArrayLiteralExpression(args[2]))
          throw Error("Review the Metro refresh serialization");
        const id = literal(args[1]);
        const raw = node.getText(source);
        const start = source.getLineAndCharacterOfPosition(node.getStart(source)),
          end = source.getLineAndCharacterOfPosition(node.end);
        return {
          id,
          ...metadata.moduleRefresh(id),
          dependencies: args[2].elements.map(literal),
          code: args.length === 3 ? raw.replace(/\);\s*$/, ",undefined);") : raw,
          span: {
            startLine: start.line,
            startColumn: start.character,
            endLine: end.line,
            endColumn: end.character,
          },
          sha256: createHash("sha256").update(raw).digest("hex"),
        };
      }),
    };
  }
  for (const file of output) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.contents);
  }
  return {
    outfile: resolve(outfile),
    modules: definitions.length,
    entryModuleId: actualId,
    ...(refreshGraph ? { refreshGraph } : {}),
    ...(metafile ? { metafile } : {}),
    files: output.map((file) => ({
      path: file.path,
      bytes: Buffer.byteLength(file.contents),
      sha256: createHash("sha256").update(file.contents).digest("hex"),
    })),
  };
}
