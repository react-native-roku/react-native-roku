import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { rokuPlugin } from "./esbuild.mjs";
import { withRokuBabelTransformer } from "./metro.cjs";
import { createRokuImageAssets, packageRokuMetroAsset } from "./assets.cjs";

const root = resolve(import.meta.dirname, "..");
const sharp = createRequire(resolve(root, "node_modules/@roku-sdk/tooling/package.json"))("sharp");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 24);
const image = (width, height, background, format = "png") =>
  sharp({ create: { width, height, channels: 4, background } })
    [format]()
    .toBuffer();

test("Metro image preparation preserves other platforms and immutable transform arguments", async () => {
  const generatedDirectory = mkdtempSync(resolve(tmpdir(), "roku-raster-transform-"));
  try {
    const uri = `data:image/png;base64,${(await image(2, 3, "red")).toString("base64")}`;
    const args = {
      filename: "image.ts",
      src: `export const image='${uri}';`,
      options: { projectRoot: root, platform: "web" },
    };
    const upstream = {
      transform(value) {
        assert.equal(this, upstream);
        return value;
      },
    };
    const transformer = withRokuBabelTransformer(upstream, {
      root,
      imageAssets: { generatedDirectory },
    });
    assert.equal(transformer.transform(args), args);
    const rokuArgs = { ...args, options: { ...args.options, platform: "roku" } };
    const source = rokuArgs.src;
    const result = await transformer.transform(rokuArgs);
    assert.equal(rokuArgs.src, source);
    assert.ok(result.src.includes(source));
    assert.ok(result.src.includes("registerPackagedImage"));
    const wrapped = withRokuBabelTransformer(transformer, { root });
    assert.equal((await wrapped.transform(rokuArgs)).src, result.src);
  } finally {
    rmSync(generatedDirectory, { recursive: true, force: true });
  }
});

test("prepared Metro image snapshots refuse source or manifest drift and preserve upstream lifetime", () => {
  const generatedDirectory = mkdtempSync(resolve(tmpdir(), "roku-image-snapshot-"));
  try {
    const filename = resolve(root, "src/image-snapshot.ts");
    const src = 'export const image="original";';
    const preparedSourcesPath = resolve(generatedDirectory, "prepared.json");
    writeFileSync(
      preparedSourcesPath,
      JSON.stringify({
        [filename]: {
          sha256: createHash("sha256").update(src).digest("hex"),
          contents: 'export const image="prepared";',
        },
      }),
    );
    const upstream = {
      transform(args) {
        assert.equal(this, upstream);
        return args;
      },
    };
    const transformer = withRokuBabelTransformer(upstream, {
      root,
      imageAssets: false,
      preparedSourcesPath,
    });
    const args = { filename, src, options: { projectRoot: root, platform: "roku" } };
    assert.match(transformer.transform(args).src, /prepared/);
    assert.equal(args.src, src);
    const other = { ...args, options: { ...args.options, platform: "web" } };
    assert.equal(transformer.transform(other), other);
    assert.throws(() => transformer.transform({ ...args, src: src + "\n" }), /source changed/);
    const wrapped = withRokuBabelTransformer(transformer, { root });
    assert.equal(wrapped.transform(args).src, transformer.transform(args).src);
    writeFileSync(preparedSourcesPath, "{}");
    assert.throws(() => wrapped.getCacheKey(), /snapshot changed/);
  } finally {
    rmSync(generatedDirectory, { recursive: true, force: true });
  }
});

test("raster assets preserve bytes, convert WebP and retain per-source identities", async () => {
  const generatedDirectory = mkdtempSync(resolve(tmpdir(), "roku-raster-assets-"));
  try {
    const compiler = createRokuImageAssets({ root, generatedDirectory });
    const webp = await image(4, 6, "red", "webp");
    const png = await sharp(webp).png().toBuffer();
    const descriptor = await compiler.packageImage(webp, "z.webp", "webp");
    assert.deepEqual(descriptor, { uri: `pkg:/images/asset-${sha(png)}.png`, width: 4, height: 6 });
    assert.deepEqual(
      readFileSync(resolve(generatedDirectory, "assets", descriptor.uri.split("/").at(-1))),
      png,
    );
    await compiler.packageImage(webp, "a.webp", "webp");
    assert.equal(compiler.inventory().size, 1);
    assert.equal(compiler.inventory().values().next().value.source, "a.webp");
    assert.equal(
      compiler
        .inventory(new Set(["z.webp"]))
        .values()
        .next().value.source,
      "z.webp",
    );
    assert.equal(compiler.inventory(new Set()).size, 0);
    await assert.rejects(
      () => compiler.packageImage(png, "no.gif", "gif"),
      /Unsupported Roku raster/,
    );
  } finally {
    rmSync(generatedDirectory, { recursive: true, force: true });
  }
});

test("Metro density selection and cache restoration retain logical dimensions and SDK imports", async () => {
  const generatedDirectory = mkdtempSync(resolve(tmpdir(), "roku-raster-density-"));
  try {
    const files = [
      resolve(generatedDirectory, "picture@0.5x.png"),
      resolve(generatedDirectory, "picture@2x.png"),
    ];
    const low = await image(2, 3, "red"),
      high = await image(8, 12, "blue");
    writeFileSync(files[0], low);
    writeFileSync(files[1], high);
    const raw = {
      files,
      scales: [0.5, 2],
      name: "picture",
      type: "png",
      width: 4,
      height: 6,
      custom: "kept",
    };
    const options = { root, generatedDirectory };
    const prepared = await packageRokuMetroAsset(raw, options);
    assert.equal(prepared.custom, "kept");
    assert.deepEqual(prepared.files, files);
    assert.deepEqual(prepared.rokuSource, {
      uri: `pkg:/images/asset-${sha(high)}.png`,
      width: 4,
      height: 6,
    });
    assert.deepEqual(
      (await packageRokuMetroAsset(raw, { ...options, scale: 3 })).rokuSource,
      prepared.rokuSource,
    );
    assert.equal(
      (await packageRokuMetroAsset(raw, { ...options, scale: 0.25 })).rokuSource.uri,
      `pkg:/images/asset-${sha(low)}.png`,
    );
    rmSync(resolve(generatedDirectory, "assets"), { recursive: true });
    rmSync(resolve(generatedDirectory, "asset-metadata"), { recursive: true });
    const compiler = createRokuImageAssets(options);
    await compiler.restoreMetroAssets([prepared]);
    assert.deepEqual(
      readFileSync(resolve(generatedDirectory, "assets", `asset-${sha(high)}.png`)),
      high,
    );
    const module = resolve(generatedDirectory, "native/images.ts");
    const inventory = compiler.writeSdkModule(module);
    assert.equal(inventory.size, 1);
    assert.equal(
      compiler.writeSdkModule(
        resolve(generatedDirectory, "native/selected.ts"),
        new Set([relative(root, files[1])]),
      ).size,
      1,
      "SDK filtering must accept Metro's selected density-module identity",
    );
    assert.match(
      readFileSync(module, "utf8"),
      /import \* as image0 from "\.\.\/assets\/asset-[a-f0-9]{24}\.png"/,
    );
    await assert.rejects(
      () => packageRokuMetroAsset({ ...raw, scales: [1, 1] }, options),
      /Review the Metro/,
    );
    await assert.rejects(
      () => packageRokuMetroAsset({ ...raw, width: 99 }, options),
      /Inconsistent Metro/,
    );
    await assert.rejects(
      () =>
        compiler.restoreMetroAssets([
          { ...prepared, rokuSource: { ...prepared.rokuSource, width: 99 } },
        ]),
      /Cached Roku raster changed/,
    );
  } finally {
    rmSync(generatedDirectory, { recursive: true, force: true });
  }
});

test("embedded values keep exact authored strings and ignore comments while preparing dependencies", async () => {
  const generatedDirectory = mkdtempSync(resolve(tmpdir(), "roku-raster-embedded-"));
  try {
    const compiler = createRokuImageAssets({ root, generatedDirectory });
    const uri = `data:image/png;base64,${(await image(2, 3, "red")).toString("base64")}`;
    const original = `export const values=[${JSON.stringify(uri)},'${uri}',\`${uri}\`];\nexport const node=<Image source="${uri}"/>;`;
    const prepared = await compiler.prepareEmbeddedSource(
      resolve(root, "src/fixture.tsx"),
      original,
      { inline: true },
    );
    assert.ok(prepared.endsWith(original));
    assert.equal(prepared.split("\n").filter((line) => line.startsWith("import ")).length, 1);
    assert.equal(compiler.inventory().size, 1);
    const comment = `// ${JSON.stringify(uri)}\nexport const x=1;`;
    assert.equal(await compiler.prepareEmbeddedSource("comment.ts", comment), comment);
    assert.equal(
      await compiler.prepareEmbeddedSource("plain.ts", "export const x=1;"),
      "export const x=1;",
    );
    const prefix = 'export const accepts=source=>source.startsWith("data:image/");';
    assert.equal(await compiler.prepareEmbeddedSource("prefix.ts", prefix), prefix);
    const directive = await compiler.prepareEmbeddedSource(
      "directive.ts",
      `"use client";\nexport const image='${uri}';`,
      { inline: true },
    );
    assert.ok(directive.startsWith('"use client";'));
    assert.ok(directive.includes(`export const image='${uri}';`));
    const config = compiler.metroConfiguration();
    assert.ok(readFileSync(config.assetPlugins[0], "utf8").includes("packageRokuMetroAsset"));
    assert.match(readFileSync(config.assetRegistryPath, "utf8"), /registerAsset/);
    await assert.rejects(
      () =>
        compiler.prepareEmbeddedSource("bad.ts", 'export const x="data:image/png;base64,garbage"'),
      /Invalid embedded|Input buffer/,
    );
    await assert.rejects(
      () => compiler.prepareEmbeddedSource("bad.ts", 'export const x="data:image/svg+xml,<svg/>"'),
      /Unsupported embedded/,
    );
  } finally {
    rmSync(generatedDirectory, { recursive: true, force: true });
  }
});

test("embedded image preparation preserves dynamic URI prefixes and rejects complete unsupported images", async () => {
  const generatedDirectory = mkdtempSync(resolve(tmpdir(), "roku-raster-prefix-"));
  try {
    const compiler = createRokuImageAssets({ root, generatedDirectory });
    const source = [
      'export const accepts=value=>value.startsWith("data:image/");',
      'export const png=payload=>"data:image/png;base64,"+payload;',
      "export const gif=payload=>'data:image/gif;base64,'+payload;",
      "export const svg=payload=>`data:image/svg+xml,`+payload;",
    ].join("\n");
    for (const inline of [false, true])
      assert.equal(
        await compiler.prepareEmbeddedSource("constructors.mjs", source, { inline }),
        source,
      );
    assert.equal(compiler.inventory().size, 0);
    await assert.rejects(
      () =>
        compiler.prepareEmbeddedSource(
          "complete-gif.mjs",
          'export const image="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";',
        ),
      /Unsupported embedded/,
    );
  } finally {
    rmSync(generatedDirectory, { recursive: true, force: true });
  }
});

test("esbuild resolves the original embedded value to its packaged Poster and retires the mounted image", async () => {
  mkdirSync(resolve(root, ".local"), { recursive: true });
  const generatedDirectory = mkdtempSync(resolve(root, ".local/roku-raster-esbuild-"));
  try {
    const compiler = createRokuImageAssets({ root, generatedDirectory });
    const png = await image(2, 3, "red");
    const uri = `data:image/png;base64,${png.toString("base64")}`;
    writeFileSync(resolve(generatedDirectory, "picture.png"), png);
    const entry = resolve(generatedDirectory, "entry.tsx"),
      outfile = resolve(generatedDirectory, "application.mjs");
    writeFileSync(
      entry,
      `
      import {createElement} from "react";
      import {createNativeRoot} from "react-native-roku";
      import {RecordingSceneGraph} from "react-native-roku/testing";
      import {Image} from "react-native-roku/image";
      import raster from "./picture.png";
      const authored='${uri}';
      type AuthoredURI='${uri}';
      const values=["${uri}",'${uri}',\`${uri}\`];
      const keyed={"${uri}":42};
      const Artwork=()=> <Image source="${uri}" style={{width:20,height:20}}/>;
      export function qualify(){
        const scene=new RecordingSceneGraph();
        const baselineNodes=scene.nodes.size;
        const root=createNativeRoot(scene,{viewport:{width:800,height:600},text:{prepare(){},metrics:()=>({lineHeight:20,width:()=>10})}});
        root.render(createElement(Artwork));
        const poster=[...scene.nodes.values()].find(node=>node.type==="poster");
        const result={authored,values,keys:Object.keys(keyed),raster,uri:poster?.fields.uri};
        root.unmount();
        return {...result,listeners:scene.listenerCount,nodes:scene.nodes.size,baselineNodes};
      }
    `,
    );
    await build({
      absWorkingDir: root,
      nodePaths: [resolve(root, "node_modules")],
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2021",
      jsx: "automatic",
      define: { __DEV__: "false", "process.env.NODE_ENV": '"production"' },
      plugins: [compiler.esbuildPlugin(), rokuPlugin({ root, generatedDirectory })],
    });
    const module = await import(pathToFileURL(outfile).href);
    const result = module.qualify();
    assert.equal(result.authored, uri);
    assert.deepEqual(result.values, [uri, uri, uri]);
    assert.deepEqual(result.keys, [uri]);
    assert.equal(result.uri, `pkg:/images/asset-${sha(png)}.png`);
    assert.deepEqual(result.raster, { uri: result.uri, width: 2, height: 3 });
    assert.equal(result.listeners, 0);
    assert.equal(result.nodes, result.baselineNodes);
  } finally {
    rmSync(generatedDirectory, { recursive: true, force: true });
  }
});
