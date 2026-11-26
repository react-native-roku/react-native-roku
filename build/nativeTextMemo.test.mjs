import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transformSync } from "@babel/core";
import { transformSync as lower } from "esbuild";
import { nativeTextMemo } from "./nativeTextMemo.mjs";
import { usesReactJsxRuntime } from "./reactCompiler.mjs";

function compile(source, evaluate = true) {
  let sites = 0;
  const { code } = transformSync(source, {
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: ["jsx"] },
    plugins: [
      (babel) =>
        nativeTextMemo(babel, () => {
          sites++;
        }),
    ],
  });
  if (!evaluate) return { sites };
  const { code: script } = lower(code, { loader: "jsx", format: "cjs", jsxFactory: "element" });
  const module = { exports: {} };
  const element = (type, props, ...children) => ({ type, props, children });
  const require = (module) => {
    if (module === "roku-compiler:pressable") {
      return {
        markPressableStyle: Object.freeze,
        markPressableElement: (value, keys) => Object.assign(value, { prepared: true, keys }),
      };
    }
    assert.equal(module, "react-native");
    return { Text: "label", View: "group", Pressable: "button" };
  };
  new Function("module", "require", "element", script)(module, require, element);
  return { sites, exports: module.exports };
}

test("reuses equivalent scalar JSX while evaluating current values in source order", () => {
  const { sites, exports } = compile(`
    import { Pressable as Card, Text as Title } from "react-native";
    export function screen(trace, width, value) {
      return <Card><Title style={{ width: trace("style", width), height: 20 }}>
        {trace("children", value)}
      </Title></Card>;
    }
  `);
  assert.equal(sites, 1);
  const order = [];
  const trace = (key, value) => {
    order.push(key);
    return value;
  };
  const render = (width, value) => exports.screen(trace, width, value).children[0];
  const first = render(42, "Route");
  assert.equal(render(42, "Route"), first);
  assert.deepEqual(order, ["style", "children", "style", "children"]);
  const resized = render(72, "Route");
  assert.notEqual(resized, first);
  assert.equal(resized.props.style.width, 72);
  assert.equal(first.props.style.width, 42);
  assert.notEqual(render(72, "New Route"), resized);

  const dynamicValue = { type: "animated width" };
  const dynamic = render(dynamicValue, "Route");
  assert.equal(dynamic.props.style.width, dynamicValue);
  assert.notEqual(render(dynamicValue, "Route"), dynamic);
  assert.equal(render(72, "Route"), resized);
  const oversized = "x".repeat(257);
  assert.notEqual(render(oversized, "Route"), render(oversized, "Route"));
  assert.ok(Object.is(render(42, -0).children[0], -0));
  assert.ok(Object.is(render(42, 0).children[0], 0));
});

test("leaves inline whitespace, caller-owned props and React Compiler opt-outs alone", () => {
  const { sites, exports } = compile(`
    import { Text, View } from "react-native";
    export function space(value) { return <View><Text style={{ width: 1 }}> {value}</Text></View> }
    export function ref(value, ref) { return <View><Text ref={ref} style={{ width: 1 }}>{value}</Text></View> }
    export function style(value, style) { return <View><Text style={style}>{value}</Text></View> }
    export function nested(value) { return <Text><Text style={{ width: 1 }}>{value}</Text></Text> }
    export function ignored(value) { "use no memo"; return <View><Text style={{ width: 1 }}>{value}</Text></View> }
    export function shadowed(Text, value) { return <View><Text style={{ width: 1 }}>{value}</Text></View> }
  `);
  assert.equal(sites, 0);
  assert.deepEqual(exports.space("Route").children[0].children, [" ", "Route"]);
  const callback = () => {};
  const style = { width: 20 };
  assert.equal(exports.ref("Route", callback).children[0].props.ref, callback);
  assert.equal(exports.style("Route", style).children[0].props.style, style);
  assert.notEqual(exports.ignored("Route").children[0], exports.ignored("Route").children[0]);
  assert.equal(exports.shadowed("other", "Route").children[0].type, "other");
});

test("leaves JSX from custom factories and runtimes with its authored evaluation", async () => {
  const root = mkdtempSync(join(tmpdir(), "rnr-jsx-runtime-"));
  try {
    writeFileSync(join(root, "index.tsx"), "export {};");
    writeFileSync(
      join(root, "base.json"),
      JSON.stringify({ compilerOptions: { jsx: "react-jsx" } }),
    );
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ extends: "./base.json" }));
    const options = { jsx: "automatic", absWorkingDir: root, tsconfig: "tsconfig.json" };
    assert.equal(await usesReactJsxRuntime(options), true);
    assert.equal(await usesReactJsxRuntime({ ...options, jsxImportSource: "custom" }), false);
    writeFileSync(
      join(root, "base.json"),
      JSON.stringify({ compilerOptions: { jsx: "react-jsx", jsxImportSource: "custom" } }),
    );
    assert.equal(await usesReactJsxRuntime(options), false);
    assert.equal(
      compile(
        `/** @jsxImportSource custom */
         import { Text, View } from "react-native";
         export function Route(value) { return <View><Text style={{width: 1}}>{value}</Text></View> }`,
        false,
      ).sites,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("marks literal Pressable props and scalar returned styles without touching caller bindings", () => {
  const { sites, exports } = compile(`
    import { View, Text, Pressable as Card } from "react-native";
    export function screen(read, ref, label) {
      return <View><Card nativeID={label} ref={ref} onPress={ref} style={({ focused }) => {
        return { left: read("left"), top: read("top"), backgroundColor: focused ? "red" : "blue" };
      }}><Text style={{ width: 20 }}>{label}</Text></Card></View>;
    }
    export function multiple(read, label) {
      return <Card style={() => ({ left: read("left"), top: read("top") })}><View /><Text style={{ width: 20 }}>{label}</Text></Card>;
    }
    export function spread(props) {
      return <Card {...props} style={() => ({ left: props.a, top: props.b })} />;
    }
    export function extended() {
      return <Card accessibilityState={{ disabled: true }} style={() => ({ left: Math.PI, top: Math.E })} />;
    }
  `);
  assert.equal(sites, 3);
  const ref = () => {};
  const order = [];
  const values = { left: 4, top: 8 };
  const read = (key) => {
    order.push(key);
    return values[key];
  };
  const element = exports.screen(read, ref, "label").children[0];
  assert.equal(element.prepared, true);
  assert.equal(element.props.ref, ref);
  assert.equal(element.props.onPress, ref);
  const resting = element.props.style({ focused: false });
  assert.equal(element.props.style({ focused: false }), resting);
  assert.deepEqual(order, ["left", "top", "left", "top"]);
  const focused = element.props.style({ focused: true });
  assert.equal(focused.backgroundColor, "red");
  assert.equal(resting.backgroundColor, "blue");
  assert.equal(Object.isFrozen(resting), true);
  values.top = { measured: 2 };
  assert.equal(element.props.style({ focused: false }).top, values.top);
  assert.equal(Object.isFrozen(element.props.style({ focused: false })), false);
  assert.equal(exports.multiple(read, "label").prepared, undefined);
  assert.equal(exports.spread({ a: 1, b: 2 }).prepared, undefined);
  assert.equal(exports.extended().prepared, undefined);
});
