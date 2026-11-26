const { createHash, randomUUID } = require("node:crypto");
const { createRequire } = require("node:module");
const {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { dirname, relative, resolve, sep } = require("node:path");

const sha = (value) => createHash("sha256").update(value).digest("hex");
const slash = (path) => path.split(sep).join("/");
function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
function settings(options) {
  if (typeof options?.generatedDirectory !== "string" || !options.generatedDirectory)
    throw Error("Roku image assets require an owned generatedDirectory");
  const root = resolve(options.root ?? process.cwd());
  const scale = options.scale ?? 1;
  if (!(Number.isFinite(scale) && scale > 0)) throw Error("Roku image scale must be positive");
  return { root, generatedDirectory: resolve(root, options.generatedDirectory), scale };
}
function recordImage(generatedDirectory, record) {
  write(
    resolve(
      generatedDirectory,
      "asset-metadata",
      `${record.name}-${sha(record.source).slice(0, 24)}.json`,
    ),
    JSON.stringify(record) + "\n",
  );
}

/** Shared raster preparation for esbuild, Metro workers and cache-hit builds. */
exports.createRokuImageAssets = function createRokuImageAssets(options) {
  const { root, generatedDirectory, scale } = settings(options);
  let sharp;
  const metadataDirectory = resolve(generatedDirectory, "asset-metadata");
  if (options.reset) rmSync(metadataDirectory, { recursive: true, force: true });
  function rasterTool() {
    return (sharp ??= createRequire(resolve(root, "node_modules/@roku-sdk/tooling/package.json"))(
      "sharp",
    ));
  }
  async function packageImage(content, source, extension) {
    extension = extension.toLowerCase();
    if (!["png", "jpg", "jpeg", "webp"].includes(extension))
      throw Error(`Unsupported Roku raster asset: ${source}`);
    if (typeof source !== "string" || !source)
      throw Error("Roku raster assets require source identity");
    const originalMetadata = await rasterTool()(content).metadata();
    if ((originalMetadata.pages ?? 1) !== 1)
      throw Error(`Roku raster needs a single static image: ${source}`);
    const raster = extension === "webp" ? await rasterTool()(content).png().toBuffer() : content;
    const suffix = extension === "webp" ? "png" : extension === "jpeg" ? "jpg" : extension;
    const name = `asset-${sha(raster).slice(0, 24)}.${suffix}`;
    const { width, height, pages } = await rasterTool()(raster).metadata();
    if (!(width > 0 && height > 0) || (pages ?? 1) !== 1)
      throw Error(`Roku raster needs a single static image with dimensions: ${source}`);
    const output = resolve(generatedDirectory, "assets", name);
    if (!existsSync(output) || !readFileSync(output).equals(raster)) write(output, raster);
    recordImage(generatedDirectory, { name, source, width, height });
    return { uri: `pkg:/images/${name}`, width, height };
  }
  async function prepareEmbeddedSource(path, original, { inline = false } = {}) {
    if (resolve(root, path).startsWith(resolve(generatedDirectory, "embedded-images") + sep))
      return original;
    if (!original.includes("data:image/")) return original;
    const ts = require("typescript");
    const parsed = ts.createSourceFile(
      path,
      original,
      ts.ScriptTarget.Latest,
      true,
      /\.[jt]sx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const literals = new Set();
    const occurrences = [];
    function visit(node) {
      if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))
        return;
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const parent = node.parent;
        if (
          ts.isTaggedTemplateExpression(parent) ||
          (ts.isExpressionStatement(parent) && parent.expression === node) ||
          ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
            parent.moduleSpecifier === node)
        )
          return;
        // Libraries may concatenate a MIME prefix with a runtime payload.
        // Only complete literals can become packaged build-time images.
        if (/^data:image\/[^,]+,[\s\S]+$/.test(node.text)) {
          literals.add(node.text);
          occurrences.push(node);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(parsed);
    const registrations = [];
    const dependencies = new Map();
    let alias = "__rokuRegisterPackagedImage";
    while (original.includes(alias)) alias += "_";
    for (const literal of literals) {
      const match = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(literal);
      if (!match) throw Error(`Unsupported embedded Roku raster in ${path}`);
      const content = Buffer.from(match[2], "base64");
      if (content.toString("base64").replace(/=+$/, "") !== match[2].replace(/=+$/, ""))
        throw Error(`Invalid embedded Roku raster in ${path}`);
      const asset = await packageImage(
        content,
        `${slash(relative(root, path))}#embedded`,
        match[1],
      );
      registrations.push(`${alias}(${JSON.stringify(literal)},${JSON.stringify(asset.uri)});`);
      if (!inline) {
        const dependency = resolve(
          generatedDirectory,
          "embedded-images",
          `${asset.uri.split("/").at(-1)}-${sha(literal).slice(0, 24)}.mjs`,
        );
        write(
          dependency,
          `import {registerPackagedImage} from "react-native-roku/image";\nexport const source=registerPackagedImage(${JSON.stringify(literal)},${JSON.stringify(asset.uri)});\n`,
        );
        dependencies.set(literal, dependency);
      }
    }
    // Preserve every authored value, including schema-validated strings and
    // JSX attributes. Static imports register the mapping before evaluation.
    if (!registrations.length) return original;
    if (!inline) {
      let result = original;
      for (const node of occurrences.sort((a, b) => b.getStart(parsed) - a.getStart(parsed))) {
        let replacement = `require(${JSON.stringify(dependencies.get(node.text))}).source`;
        if (ts.isJsxAttribute(node.parent)) replacement = `{${replacement}}`;
        else if (node.parent.name === node) replacement = `[${replacement}]`;
        result = result.slice(0, node.getStart(parsed)) + replacement + result.slice(node.end);
      }
      return result;
    }
    let insert = original.startsWith("#!") ? original.indexOf("\n") + 1 : 0;
    for (const statement of parsed.statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
      insert = statement.end;
    }
    const prefix =
      `\nimport {registerPackagedImage as ${alias}} from "react-native-roku/image";\n` +
      registrations.join("\n") +
      "\n";
    return original.slice(0, insert) + prefix + original.slice(insert);
  }
  function inventory(used) {
    const assets = new Map();
    if (!existsSync(metadataDirectory)) return assets;
    for (const name of readdirSync(metadataDirectory).sort()) {
      if (!name.endsWith(".json")) continue;
      const record = JSON.parse(readFileSync(resolve(metadataDirectory, name)));
      if (used && !used.has(record.source.replace(/#embedded$/, ""))) continue;
      const old = assets.get(record.name);
      if (!old || record.source < old.source)
        assets.set(record.name, {
          source: record.source,
          width: record.width,
          height: record.height,
        });
    }
    return new Map([...assets].sort(([a], [b]) => a.localeCompare(b)));
  }
  async function restoreMetroAssets(descriptors) {
    if (!Array.isArray(descriptors))
      throw Error("Roku image preparation needs Metro asset descriptors");
    for (const descriptor of descriptors) {
      const prepared = await exports.packageRokuMetroAsset(descriptor, {
        root,
        generatedDirectory,
        scale,
      });
      if (
        descriptor.rokuSource &&
        JSON.stringify(descriptor.rokuSource) !== JSON.stringify(prepared.rokuSource)
      )
        throw Error(`Cached Roku raster changed during preparation: ${descriptor.name}`);
    }
  }
  function metroConfiguration() {
    const plugin = resolve(generatedDirectory, "image-asset-plugin.cjs");
    const registry = resolve(generatedDirectory, "image-asset-registry.mjs");
    write(
      plugin,
      `module.exports=data=>require(${JSON.stringify(__filename)}).packageRokuMetroAsset(data,${JSON.stringify({ root, generatedDirectory, scale })});\n`,
    );
    write(
      registry,
      'export function registerAsset(data){const source=data.rokuSource;if(!source||!/^pkg:\\/images\\/asset-[a-f0-9]{24}\\.(png|jpe?g)$/.test(source.uri))throw Error("Unprepared Roku raster asset");return source;}\n',
    );
    return { assetPlugins: [plugin], assetRegistryPath: registry };
  }
  function writeSdkModule(path, used) {
    const assets = inventory(used);
    write(
      path,
      [...assets.keys()]
        .map((name, i) => {
          const specifier = slash(
            relative(dirname(path), resolve(generatedDirectory, "assets", name)),
          );
          return `import * as image${i} from ${JSON.stringify(specifier.startsWith(".") ? specifier : "./" + specifier)};`;
        })
        .join("\n") +
        `\nexport const staticAssets:readonly {readonly uri:string}[]=[${[...assets.keys()].map((_, i) => `image${i}`).join(",")}];\n`,
    );
    return assets;
  }
  function esbuildPlugin() {
    return {
      name: "react-native-roku-images",
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) => {
          const embedded = resolve(generatedDirectory, "embedded-images") + sep;
          if (args.path.startsWith(embedded)) return { path: args.path };
          if (args.importer.startsWith(embedded) && args.path === "react-native-roku/image")
            return { path: createRequire(resolve(root, "package.json")).resolve(args.path) };
        });
        builder.onLoad({ filter: /\.(png|jpe?g|webp)$/i }, async ({ path }) => ({
          loader: "json",
          contents: JSON.stringify(
            await packageImage(
              readFileSync(path),
              slash(relative(root, path)),
              path.split(".").at(-1),
            ),
          ),
        }));
        builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
          const original = readFileSync(path, "utf8");
          if (!original.includes("data:image/")) return undefined;
          const contents = await prepareEmbeddedSource(path, original);
          if (contents === original) return undefined;
          return {
            contents,
            loader: /\.tsx?$/.test(path) ? (path.endsWith("x") ? "tsx" : "ts") : "jsx",
          };
        });
      },
    };
  }
  return {
    packageImage,
    prepareEmbeddedSource,
    inventory,
    restoreMetroAssets,
    metroConfiguration,
    writeSdkModule,
    esbuildPlugin,
  };
};

/** Metro assetPlugin: choose the first adequate density, or the largest. */
exports.packageRokuMetroAsset = async function packageRokuMetroAsset(data, options) {
  const normalized = settings(options);
  if (
    !Array.isArray(data.files) ||
    !data.files.length ||
    !Array.isArray(data.scales) ||
    data.files.length !== data.scales.length ||
    data.files.some((path) => typeof path !== "string") ||
    data.scales.some((value) => !Number.isFinite(value) || value <= 0) ||
    new Set(data.scales).size !== data.scales.length
  )
    throw Error("Review the Metro raster descriptor");
  const ordered = data.scales.map((value, i) => ({ value, i })).sort((a, b) => a.value - b.value);
  const selected = ordered.find((value) => value.value >= normalized.scale) ?? ordered.at(-1);
  const compiler = exports.createRokuImageAssets(normalized);
  const source = await compiler.packageImage(
    readFileSync(data.files[selected.i]),
    slash(relative(normalized.root, data.files[0])),
    data.type,
  );
  const width = data.width ?? source.width / selected.value;
  const height = data.height ?? source.height / selected.value;
  if (
    !(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) ||
    Math.abs(width - source.width / selected.value) > 1e-6 ||
    Math.abs(height - source.height / selected.value) > 1e-6
  )
    throw Error(`Inconsistent Metro raster dimensions: ${data.name ?? data.files[0]}`);
  // Metro can identify an asset group by any resolved density file. Associate
  // the selected packaged raster with every physical member so SDK emission
  // filtering retains the group even when no 1x source exists.
  for (const path of data.files)
    recordImage(normalized.generatedDirectory, {
      name: source.uri.split("/").at(-1),
      source: slash(relative(normalized.root, path)),
      width: source.width,
      height: source.height,
    });
  return { ...data, rokuSource: { ...source, width, height } };
};
