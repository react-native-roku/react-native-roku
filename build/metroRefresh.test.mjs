import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createRokuMetroRefreshSession, isRefreshSafeSource } from "./metroRefresh.mjs";
import { GenMapping, addMapping, setSourceContent, toEncodedMap } from "@jridgewell/gen-mapping";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";

test("refresh lifetimes preserve ordinary components/data and reject resource initialization and lookalike wrappers", () => {
  for (const source of [
    'import React,{memo as cached,forwardRef} from "react";export default cached(function Counter(){return null;});',
    'import {StyleSheet as Styles} from "react-native";const styles=Styles.create({box:{width:2}});export const format=value=>String(value);',
    "export const sizes={width:2,nested:[true,null,-1]};export function helper(){return new Map();}",
    'import * as React from "react";export const Label=React.forwardRef(()=>null);Label.displayName="Label";',
    'export function Counter(){return null;}Counter.displayName="Counter";',
  ])
    assert.equal(isRefreshSafeSource("sample.tsx", source), true, source);
  for (const source of [
    'const socket=new WebSocket("ws://example.invalid");export default function App(){return null;}',
    'import React from "react";export const Context=React.createContext(null);',
    'import {memo} from "unreviewed-library";export default memo(function App(){return null;});',
    "const value=++globalCounter;export function Counter(){return value;}",
    "setInterval(()=>{},100);export const x=1;",
    "export const broken = (",
    'import Label from "library";Label.displayName="Changed";',
    'import Label from "library";const Alias=Label;Alias.displayName="Changed";',
    "export function Counter(){return null;}Counter.resource=new Map();",
  ])
    assert.equal(isRefreshSafeSource("sample.tsx", source), false, source);
});

test("static refresh patches preserve original source locations and refuse a changed source-map snapshot", () => {
  const root = mkdtempSync(resolve(tmpdir(), "roku-refresh-maps-"));
  const session = createRokuMetroRefreshSession({ root, directory: resolve(root, "session") });
  try {
    const code = '__d(function(){return 42},0,[],"Counter");';
    const original = "export const original = 42;",
      map = new GenMapping();
    setSourceContent(map, "Counter.tsx", original);
    addMapping(map, {
      generated: { line: 7, column: code.indexOf("42") },
      original: { line: 1, column: 24 },
      source: "Counter.tsx",
      name: "original",
    });
    const path = resolve(root, "source.map"),
      bytes = JSON.stringify(toEncodedMap(map));
    writeFileSync(path, bytes);
    const graph = (generation, hash) => ({
      sessionId: session.id,
      generation,
      runtimeSha256: "runtime",
      bootstrapSha256: "entry",
      bindings: ["__d", "__r"],
      maxModuleBytes: 2048,
      sourceMap: {
        path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        url: "file:///project/bundle.map",
      },
      modules: [
        {
          id: 0,
          source: "Counter.tsx",
          safe: true,
          dependencies: [],
          code,
          sha256: hash,
          span: { startLine: 6, startColumn: 0, endLine: 6, endColumn: code.length },
        },
      ],
    });
    session.stage({
      generation: 1,
      graph: graph(1, "old"),
      identity: "same",
      outputDirectory: root,
    });
    session.publish(1);
    const update = session.stage({
      generation: 2,
      graph: graph(2, "new"),
      identity: "same",
      outputDirectory: root,
    });
    assert.equal(update.type, "refresh");
    const patch = resolve(root, update.paths[0].slice(1)),
      contents = readFileSync(patch, "utf8");
    assert.ok(Buffer.byteLength(contents) <= 2048);
    const factory = contents.indexOf(code.slice(0, -2));
    assert.ok(factory >= 0, "The patch retains the changed Metro factory");
    const before = contents.slice(0, factory + code.indexOf("42")).split("\n");
    const trace = new TraceMap(JSON.parse(readFileSync(patch + ".map", "utf8")));
    assert.deepEqual(
      originalPositionFor(trace, { line: before.length, column: before.at(-1).length }),
      { source: "file:///project/Counter.tsx", line: 1, column: 24, name: "original" },
    );
    assert.deepEqual(trace.sourcesContent, [original]);
    writeFileSync(path, "{}");
    assert.throws(
      () =>
        session.stage({
          generation: 2,
          graph: graph(2, "newer"),
          identity: "same",
          outputDirectory: root,
        }),
      /source map changed/,
    );
  } finally {
    session.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("refresh publications keep stable IDs, skip discarded builds, and reload both sides of unsafe lifetime changes", () => {
  const root = mkdtempSync(resolve(tmpdir(), "roku-refresh-contract-"));
  const session = createRokuMetroRefreshSession({
    root,
    directory: resolve(root, ".local/session"),
  });
  const graph = (generation, sha = "first", safe = true) => ({
    sessionId: session.id,
    generation,
    runtimeSha256: "runtime",
    bootstrapSha256: "entry",
    bindings: ["__d", "__r"],
    maxModuleBytes: 2048,
    modules: [
      {
        id: 0,
        source: "src/Counter.tsx",
        safe,
        dependencies: [],
        sha256: sha,
        code: '__d(function(){},0,[],"Counter.tsx");',
      },
    ],
  });
  const stage = (generation, sha, safe, identity = "same") =>
    session.stage({
      generation,
      graph: graph(generation, sha, safe),
      identity,
      outputDirectory: resolve(root, String(generation)),
    });
  try {
    let creations = 0;
    const factory = () => {
      creations++;
      const ids = new Map();
      return (path) => {
        if (!ids.has(path)) ids.set(path, ids.size);
        return ids.get(path);
      };
    };
    assert.equal(session.createModuleIdFactory(factory)()("a"), 0);
    assert.equal(session.createModuleIdFactory(factory)()("b"), 1);
    assert.equal(session.createModuleIdFactory(factory)()("a"), 0);
    assert.equal(creations, 1);
    assert.equal(
      session.classify(
        resolve(root, "src/Counter.tsx"),
        "export default function Counter(){return null;}",
      ),
      true,
    );
    assert.equal(
      session.classify(
        resolve(root, ".local/generated.tsx"),
        "export default function Counter(){return null;}",
      ),
      false,
    );
    assert.equal(stage(1).type, "reload");
    session.publish(1);
    stage(2, "discarded");
    session.discard(2);
    const update = stage(2, "edited");
    assert.equal(update.type, "refresh");
    assert.equal(update.fromGeneration, 1);
    assert.match(
      readFileSync(resolve(root, "2", update.paths[0].slice(1)), "utf8"),
      /export function apply/,
    );
    session.publish(2);
    assert.equal(stage(3, "resource", false).reason, "resource-lifetime-changed");
    session.publish(3);
    assert.equal(stage(4, "removed-resource", true).reason, "resource-lifetime-changed");
    session.publish(4);
    assert.equal(
      stage(5, "unchanged", true, "font-changed").reason,
      "configuration-assets-or-runtime-changed",
    );
    session.publish(5);
    assert.equal(stage(7, "gap").reason, "publication-gap");
    assert.throws(() => session.publish(6), /Unprepared/);
    session.dispose();
    assert.throws(() => stage(8), /retired/);
  } finally {
    session.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
