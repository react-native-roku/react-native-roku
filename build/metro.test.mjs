import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { packageRoot } from "./index.mjs";
const require = createRequire(import.meta.url),
  { withRoku, withRokuBabelTransformer } = require("./metro.cjs");
test("Metro adapter selects Roku only for its target and preserves other native resolution", () => {
  const calls = [];
  const config = withRoku({
    projectRoot: packageRoot,
    resolver: {
      platforms: ["android", "ios"],
      resolveRequest: (_context, name, platform) => {
        calls.push({ name, platform });
        return { type: "sourceFile", filePath: "native-original" };
      },
    },
  });
  const root = mkdtempSync(resolve(tmpdir(), "roku-metro-"));
  writeFileSync(resolve(root, "Control.tv.tsx"), "export default 1");
  writeFileSync(resolve(root, "Control.roku.tsx"), "export default 2");
  const context = { originModulePath: resolve(root, "App.tsx") };
  assert.match(
    config.resolver.resolveRequest(context, "react-native", "roku").filePath,
    /react-native[/\\]index\.ts$/,
  );
  assert.equal(
    config.resolver.resolveRequest(context, "react-native", "android").filePath,
    "native-original",
  );
  assert.deepEqual(calls, [{ name: "react-native", platform: "android" }]);
  assert.equal(
    config.resolver.resolveRequest(context, "./Control", "roku").filePath,
    resolve(root, "Control.roku.tsx"),
  );
  assert.throws(
    () => config.resolver.resolveRequest(context, "react-native/Libraries/Internal", "roku"),
    /Unadapted native import/,
  );
  assert.deepEqual(config.resolver.platforms, ["android", "ios", "roku"]);
});

test("Metro prepares Yoga from its immutable source and preserves upstream transform behavior", async () => {
  const binding = require.resolve("yoga-layout-prebuilt/yoga-layout/build/Release/nbind.js");
  const source = readFileSync(binding, "utf8");
  const upstream = {
    marker: "upstream identity",
    async transform(args) {
      assert.equal(this, upstream);
      return { ast: args.src, metadata: args.options };
    },
    getCacheKey(suffix) {
      assert.equal(this, upstream);
      return "upstream-key:" + suffix;
    },
  };
  const transformer = withRokuBabelTransformer(upstream, { root: packageRoot });
  assert.equal(transformer.marker, upstream.marker);
  const args = {
    filename: relative(packageRoot, binding),
    src: source + "\n// Metro snapshot\n",
    options: { projectRoot: packageRoot, platform: "roku", dev: false },
    plugins: ["preserved"],
  };
  const transformed = await transformer.transform(args);
  assert.equal(
    (await withRokuBabelTransformer(transformer, { root: packageRoot }).transform(args)).ast,
    transformed.ast,
  );
  assert.doesNotMatch(transformed.ast, /\beval\(/);
  assert.ok(transformed.ast.endsWith("// Metro snapshot\n"));
  assert.equal(transformed.metadata, args.options);
  assert.equal(args.src, source + "\n// Metro snapshot\n");
  assert.equal(readFileSync(binding, "utf8"), source);
  assert.equal(transformer.getCacheKey("a"), transformer.getCacheKey("a"));
  assert.notEqual(transformer.getCacheKey("a"), transformer.getCacheKey("b"));
  for (const platform of ["android", "ios", "web", undefined]) {
    const other = { ...args, options: { ...args.options, platform } };
    assert.equal((await transformer.transform(other)).ast, other.src);
  }
  assert.throws(
    () => transformer.transform({ ...args, src: source.replace("eval(", "changedEval(") }),
    /pinned Yoga binding changed/,
  );
});

test("Metro uses the common pinned NativeWind preparation only on Roku", () => {
  const transformer = withRokuBabelTransformer(
    { transform: (args) => args },
    { root: packageRoot },
  );
  const path = require.resolve("react-native-css-interop/dist/runtime/native/api.js");
  const args = {
    filename: path,
    src: readFileSync(path, "utf8"),
    options: { projectRoot: packageRoot, platform: "roku" },
  };
  assert.match(transformer.transform(args).src, /installStyleInterop/);
  assert.match(transformer.transform(args).src, /withPressableStyleCallbacks/);
  assert.equal(transformer.transform({ ...args, options: { platform: "android" } }).src, args.src);
  const preferences =
    require.resolve("react-native-css-interop/dist/runtime/native/appearance-observables.js");
  assert.match(
    transformer.transform({
      ...args,
      filename: preferences,
      src: readFileSync(preferences, "utf8"),
    }).src,
    /C25_PREFERENCE_PENDING/,
  );
  assert.throws(
    () => transformer.transform({ ...args, src: "changed registry" }),
    /pinned NativeWind/,
  );
  const events = require.resolve("react-native-css-interop/dist/runtime/native/native-interop.js");
  const input = { ...args, filename: events, src: readFileSync(events, "utf8") };
  assert.match(transformer.transform(input).src, /component !== react_native_1.TextInput/);
  for (const platform of ["android", "ios", "web"]) {
    const other = { ...input, options: { ...input.options, platform } };
    assert.equal(transformer.transform(other), other);
  }
  assert.throws(
    () => transformer.transform({ ...input, src: "changed state bridge" }),
    /pinned NativeWind/,
  );
});

test("Metro transformer leaves ordinary source, options and failures with the configured upstream", () => {
  const failure = new Error("upstream failure");
  const args = { filename: "App.tsx", src: "export default App", options: { platform: "roku" } };
  const transformer = withRokuBabelTransformer(
    { transform: (input) => input },
    { root: packageRoot },
  );
  assert.equal(transformer.transform(args), args);
  const broken = withRokuBabelTransformer(
    {
      transform() {
        throw failure;
      },
    },
    { root: packageRoot },
  );
  assert.throws(
    () => broken.transform(args),
    (error) => error === failure,
  );
  assert.throws(() => withRokuBabelTransformer({}), /transform/);
});

test("Metro selects one React entry profile before collecting development dependencies", () => {
  const transformer = withRokuBabelTransformer(
    { transform: (args) => args },
    { root: packageRoot },
  );
  for (const entry of ["index", "jsx-runtime", "jsx-dev-runtime", "compiler-runtime"]) {
    const path = resolve(packageRoot, "node_modules/react", entry + ".js");
    const source = readFileSync(path, "utf8");
    for (const dev of [true, false]) {
      const args = { filename: path, src: source, options: { platform: "roku", dev } };
      const result = transformer.transform(args);
      assert.ok(result.src.includes(`.${dev ? "development" : "production"}.js`));
      assert.ok(!result.src.includes(`.${dev ? "production" : "development"}.js`));
      assert.equal(result.src.length, source.length);
      assert.equal(args.src, source);
      assert.equal(
        transformer.transform({ ...args, options: { ...args.options, platform: "android" } }).src,
        source,
      );
    }
    assert.throws(
      () =>
        transformer.transform({
          filename: path,
          src: source.replace("module.exports", "changed.exports"),
          options: { platform: "roku", dev: true },
        }),
      /Review.*React entry/,
    );
  }
});

test("Roku syntax plugins compose with upstream plugins and participate in the cache", () => {
  const upstream = { transform: (args) => args };
  const plugin = require.resolve("@babel/plugin-transform-class-static-block");
  const transformer = withRokuBabelTransformer(upstream, { root: packageRoot, plugins: [plugin] });
  const args = {
    filename: "App.tsx",
    src: "class App {static {this.value=42;}}",
    plugins: ["existing"],
    options: { platform: "roku" },
  };
  assert.deepEqual(transformer.transform(args).plugins, [plugin, "existing"]);
  assert.deepEqual(
    withRokuBabelTransformer(transformer, { root: packageRoot }).transform(args).plugins,
    [plugin, "existing"],
  );
  assert.deepEqual(args.plugins, ["existing"]);
  assert.notEqual(
    transformer.getCacheKey(),
    withRokuBabelTransformer(upstream, { root: packageRoot }).getCacheKey(),
  );
  const android = { ...args, options: { platform: "android" } };
  assert.equal(transformer.transform(android), android);
});

test("Metro transformer cache includes its pinned Yoga preparation inputs", () => {
  const root = mkdtempSync(resolve(tmpdir(), "roku-metro-cache-"));
  try {
    const directory = resolve(root, "node_modules/yoga-layout-prebuilt/yoga-layout/dist");
    require("node:fs").mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(root, "package.json"), "{}");
    assert.equal(
      typeof withRokuBabelTransformer({ transform: (args) => args }, { root }).getCacheKey(),
      "string",
    );
    writeFileSync(resolve(directory, "entry-common.js"), "module.exports = 1;");
    writeFileSync(resolve(directory, "YGEnums.js"), "module.exports = 2;");
    const transformer = withRokuBabelTransformer({ transform: (args) => args }, { root });
    const before = transformer.getCacheKey();
    writeFileSync(resolve(directory, "YGEnums.js"), "module.exports = 3;");
    assert.notEqual(transformer.getCacheKey(), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
