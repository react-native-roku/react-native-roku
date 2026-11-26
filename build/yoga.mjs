import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import ts from "typescript";

function calls(source) {
  const ast = ts.createSourceFile(
      "nbind.js",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    ),
    result = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "eval") {
      let owner = node.parent;
      while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
      result.push({
        start: node.getStart(ast),
        end: node.end,
        argument: node.arguments[0].getText(ast),
        owner,
        name: owner?.name?.getText(ast),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return result;
}
function replace(source, edits) {
  for (const edit of edits.sort((a, b) => b.start - a.start))
    source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
  return source;
}

export function exerciseYoga(Yoga) {
  const config = Yoga.Config.create(),
    root = Yoga.Node.create(config),
    text = Yoga.Node.create(config);
  try {
    root.setWidth(300);
    root.setHeight(200);
    root.insertChild(text, 0);
    text.setMeasureFunc(() => ({ width: 80, height: 20 }));
    root.calculateLayout(300, 200, Yoga.DIRECTION_LTR);
    root.getComputedLayout();
    text.getComputedLayout();
    root.getWidth();
    root.getHeight();
    text.markDirty();
    root.calculateLayout(300, 200, Yoga.DIRECTION_RTL);
    text.unsetMeasureFunc();
    root.removeChild(text);
  } finally {
    text.free();
    root.free();
    config.free();
  }
}

/**
 * nbind emits closures using local eval, which Hermes does not implement. Generate
 * its finite Yoga binding signatures at build time, in their original lexical
 * factory scopes. Unknown runtime signatures fail explicitly; no runtime eval or
 * Function constructor is emitted. This changes bindings, never Yoga's layout core.
 */
export function prepareHermesYoga(bindingPath, { source: inputSource } = {}) {
  const source = (inputSource ?? readFileSync(bindingPath, "utf8")).replace(
      /(\(function \(_nbind\) \{)(?!\s*var _a;)/,
      "$1\n    var _a;",
    ),
    sites = calls(source);
  if (
    sites.length !== 4 ||
    sites.map((site) => site.name).join(",") !==
      "getCFunc,cwrap,buildCallerFunction,buildJSCallerFunction"
  )
    throw new Error("The pinned Yoga binding changed; review its code-generation boundary");
  const signatures = new Map([
    ["buildCallerFunction", new Set()],
    ["buildJSCallerFunction", new Set()],
  ]);
  const instrumented = replace(
    source,
    sites.map((site) => ({
      ...site,
      value: `(__capture__(${JSON.stringify(site.name)}, ${site.argument}), eval(${site.argument}))`,
    })),
  );
  const module = { exports: {} },
    require = createRequire(bindingPath);
  // This trusted installed dependency executes only in Node during the build.
  new Function(
    "module",
    "exports",
    "require",
    "__filename",
    "__dirname",
    "__capture__",
    instrumented,
  )(module, module.exports, require, bindingPath, dirname(bindingPath), (name, code) =>
    signatures.get(name)?.add(code),
  );
  let native;
  module.exports(
    { ENVIRONMENT: "SHELL", print: console.log, printErr: console.warn },
    (error, value) => {
      if (error) throw error;
      native = value;
    },
  );
  if (!native) throw new Error("Yoga binding initialization was not synchronous");
  const Yoga = require(resolve(dirname(bindingPath), "../../dist/entry-common.js"))(
    native.bind,
    native.lib,
  );
  exerciseYoga(Yoga);
  const edits = [];
  const ast = ts.createSourceFile(
    "nbind.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const rejectLoader = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "globalEval")
      edits.push({
        start: node.getStart(ast),
        end: node.end,
        value:
          'function globalEval() { throw new Error("C03_YOGA_DYNAMIC_LOAD: dynamic script loading is unavailable"); }',
      });
    ts.forEachChild(node, rejectLoader);
  };
  rejectLoader(ast);
  for (const site of sites) {
    if (site.name === "getCFunc") edits.push({ ...site, value: 'Module["_" + ident]' });
    else if (site.name === "cwrap")
      edits.push({
        start: site.owner.getStart(),
        end: site.owner.end,
        value:
          'function cwrap(ident, returnType, argTypes) { var cfunc = getCFunc(ident); argTypes = argTypes || []; if (returnType !== "string" && argTypes.every(function(type) { return type === "number"; })) return cfunc; return function() { return ccall(ident, returnType, argTypes, Array.prototype.slice.call(arguments)); }; }',
      });
    else {
      const known = [...signatures.get(site.name)].sort();
      if (!known.length) throw new Error(`No signatures collected for ${site.name}`);
      edits.push({
        ...site,
        value: `(function() { switch (${site.argument}) { ${known.map((code) => `case ${JSON.stringify(code)}: return (${code});`).join("\n")} default: throw new Error("C03_YOGA_SIGNATURE: unqualified binding signature " + sourceCode); } })()`,
      });
    }
  }
  const initialization = "Module.onRuntimeInitialized = function (init, cb)";
  if (source.split(initialization).length !== 2)
    throw new Error("Yoga initialization boundary changed");
  const contents = replace(source, edits).replace(
    initialization,
    'Module.ENVIRONMENT = "SHELL"; Module.print = function() { console.log.apply(console, arguments); }; Module.printErr = function() { console.warn.apply(console, arguments); }; ' +
      initialization,
  );
  if (calls(contents).length) throw new Error("Runtime eval remains in the prepared Yoga binding");
  const prepared = ts.createSourceFile(
    "prepared.js",
    contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const verify = (node) => {
    if (
      (ts.isIdentifier(node) && node.text === "eval") ||
      (ts.isNewExpression(node) && node.expression.getText(prepared) === "Function")
    )
      throw new Error("Dynamic evaluation remains in the prepared Yoga binding");
    ts.forEachChild(node, verify);
  };
  verify(prepared);
  return {
    contents,
    signatures: Object.fromEntries([...signatures].map(([name, known]) => [name, known.size])),
  };
}
