// Bundled by host-performance.mjs against the consumer's installed runtime.
// This is a host algorithm baseline, not native SceneGraph performance evidence.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { createElement as h, createRef, memo, useState, version } from "react";
import { createNativeRoot, NativeInput } from "react-native-roku";
import { View, Text, Pressable, FlatList } from "react-native-roku/react-native";

const diagnostic = process.env.HOST_PERF_DIAGNOSTIC === "1";
const samples = diagnostic ? 2 : 40;
const rounds = diagnostic ? 1 : 2;
const warmup = diagnostic ? 2 : 10;
const count = process.env.HOST_PERF_NO_COUNTERS !== "1";
const keys = ["batch", "create", "set", "insert", "remove", "subscribe", "unsubscribe"];
const empty = () => Object.fromEntries(keys.map((key) => [key, 0]));

// Minimal synchronous host port: retains current state and subscriptions, never
// operation history. Counts calls, including reorders, rather than unique nodes.
class CountingPort {
  root = { id: 0, type: "root", fields: {}, children: [], parent: null };
  nodes = new Map([[0, this.root]]);
  listeners = new Map();
  next = 0;
  epoch = 0;
  counts = empty();
  bump(key) {
    if (count) this.counts[key]++;
  }
  create(type) {
    this.bump("create");
    const node = { id: ++this.next, type, fields: {}, children: [], parent: null };
    this.nodes.set(node.id, node);
    return node;
  }
  set(node, field, value) {
    assert.equal(this.nodes.get(node.id), node);
    this.bump("set");
    node.fields[field] = value;
  }
  insert(parent, child, before) {
    this.bump("insert");
    if (before === child) return;
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    const index = before ? parent.children.indexOf(before) : parent.children.length;
    assert.ok(index >= 0);
    parent.children.splice(index, 0, child);
    child.parent = parent;
  }
  remove(parent, child) {
    this.bump("remove");
    assert.equal(child.parent, parent);
    parent.children.splice(parent.children.indexOf(child), 1);
    const retire = (node) => {
      for (const nested of node.children) retire(nested);
      this.nodes.delete(node.id);
      node.parent = null;
    };
    retire(child);
  }
  subscribe(node, field, listener) {
    this.bump("subscribe");
    const key = `${node.id}:${field}`;
    const entries = this.listeners.get(key) ?? new Set();
    entries.add(listener);
    this.listeners.set(key, entries);
    return () => {
      this.bump("unsubscribe");
      entries.delete(listener);
      if (!entries.size) this.listeners.delete(key);
    };
  }
  batch(work) {
    work();
    this.epoch++;
    this.bump("batch");
  }
  get listenerCount() {
    let total = 0;
    for (const entries of this.listeners.values()) total += entries.size;
    return total;
  }
}

function fixture(viewport = { width: 1920, height: 1080 }) {
  const port = new CountingPort(),
    input = new NativeInput();
  const root = createNativeRoot(port, {
    viewport,
    input,
    text: {
      prepare() {},
      metrics: (style) => ({
        lineHeight: Number(style.fontSize ?? 20) * 1.2,
        width: (value) => Array.from(value).length * Number(style.fontSize ?? 20) * 0.52,
      }),
    },
    onError(error) {
      throw error;
    },
  });
  return { port, input, root };
}
const noop = () => {};
const Card = memo(function Card({ index, selected, targetRef, opacity }) {
  return h(
    Pressable,
    {
      ref: targetRef,
      nativeID: `card-${index}`,
      onFocus: noop,
      style: {
        width: 140,
        height: 110,
        marginRight: 8,
        opacity: opacity ?? (selected ? 1 : 0.9),
        backgroundColor: selected ? "#4488ff" : "#202030",
      },
    },
    h(View, { style: { width: 120, height: 60, backgroundColor: "#404050" } }),
    h(Text, { style: { fontSize: 16 } }, `Title ${index}`),
    h(Text, { style: { fontSize: 12 } }, "2026 · TV"),
  );
});
function Tree({ rows, columns, driver }) {
  const [focused, focus] = useState(0);
  const [opacity, updateOpacity] = useState(1);
  driver.focus = focus;
  driver.opacity = updateOpacity;
  return h(
    View,
    { nativeID: "screen", style: { width: 1920, height: 1080 } },
    h(Text, { style: { fontSize: 28, height: 40 } }, "Host TV catalog fixture"),
    ...Array.from({ length: rows }, (_, row) =>
      h(
        View,
        {
          key: row,
          style: { flexDirection: "row", height: 120 },
        },
        ...Array.from({ length: columns }, (_, column) => {
          const index = row * columns + column;
          return h(Card, {
            key: index,
            index,
            selected: index === focused,
            targetRef: index === 0 ? driver.ref : undefined,
            opacity: index === 0 ? opacity : undefined,
          });
        }),
      ),
    ),
  );
}

const results = [],
  cleanup = [];
function structural() {
  return { ...(globalThis.__HOST_PERF_COUNTS__ ?? {}) };
}
function clearStructural() {
  if (diagnostic)
    globalThis.__HOST_PERF_COUNTS__ = {
      reactCommits: 0,
      treeCommits: 0,
      layoutCalls: 0,
      yogaNodes: 0,
    };
}
async function settleList(f) {
  let quiet = 0;
  for (let turn = 0; turn < 50; turn++) {
    const before = f.port.epoch;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await f.root.whenCommitted();
    f.root.flush();
    quiet = before === f.port.epoch ? quiet + 1 : 0;
    if (quiet >= 2) return;
  }
  throw Error("Virtual-list window did not settle in 50 event-loop turns");
}
async function timed(f, action, settle = false) {
  f.port.counts = empty();
  clearStructural();
  const start = performance.now();
  action();
  await f.root.whenCommitted();
  if (settle) await settleList(f);
  const ms = performance.now() - start;
  return { ms, ops: { ...f.port.counts }, ...structural() };
}
const quantile = (values, fraction) => {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
};
function record(dimensions, round, workload, observations, f) {
  const times = observations.map((entry) => entry.ms);
  results.push({
    ...dimensions,
    round,
    workload,
    samples: observations.length,
    medianMs: quantile(times, 0.5),
    p95Ms: quantile(times, 0.95),
    maxMs: Math.max(...times),
    realizedNodes: f.port.nodes.size - 1,
    listeners: f.port.listenerCount,
    inputTargets: f.input.targetCount,
    inputObservers: f.input.observerCount,
    // A compact raw row has timing, operation counts, then structural counters.
    columns: [
      "ms",
      ...keys,
      ...(diagnostic ? ["reactCommits", "treeCommits", "layoutCalls", "yogaNodes"] : []),
    ],
    raw: observations.map((entry) => [
      entry.ms,
      ...keys.map((key) => entry.ops[key]),
      ...(diagnostic
        ? [entry.reactCommits, entry.treeCommits, entry.layoutCalls, entry.yogaNodes]
        : []),
    ]),
  });
}
async function retire(f, dimensions) {
  const observation = await timed(f, () => f.root.unmount());
  const afterUnmount = {
    nodes: f.port.nodes.size,
    listeners: f.port.listenerCount,
    targets: f.input.targetCount,
    observers: f.input.observerCount,
  };
  f.input.dispose();
  assert.deepEqual(afterUnmount, { nodes: 1, listeners: 0, targets: 0, observers: 0 });
  cleanup.push({ ...dimensions, ...afterUnmount });
  return observation;
}
function heap() {
  globalThis.gc?.();
  const m = process.memoryUsage();
  return { heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers, rss: m.rss };
}
async function main() {
  const heapStart = heap();
  for (let round = 1; round <= rounds; round++) {
    // Reverse size order on the second pass to make warm-engine/order effects visible.
    const dimensions = [
      { size: "small", rows: 2, columns: 6 },
      { size: "medium", rows: 6, columns: 12 },
      { size: "large", rows: 10, columns: 24 },
    ];
    if (round === 2) dimensions.reverse();
    for (const d of dimensions) {
      d.cards = d.rows * d.columns;
      const mounts = [],
        unmounts = [];
      let last;
      for (let i = -warmup; i < (diagnostic ? 2 : 30); i++) {
        const f = fixture(),
          driver = { ref: createRef() };
        const observation = await timed(f, () => f.root.render(h(Tree, { ...d, driver })));
        // Capture realized dimensions before retirement.
        if (i >= 0) mounts.push(observation);
        if (i === (diagnostic ? 1 : 29)) {
          record(d, round, "initial-mount", mounts, f);
          last = f;
        }
        const unmount = await retire(f, { size: d.size, round, cycle: i });
        if (i >= 0) unmounts.push(unmount);
      }
      record(d, round, "unmount", unmounts, last);
      const f = fixture(),
        driver = { ref: createRef() };
      const element = h(Tree, { ...d, driver });
      f.root.render(element);
      await f.root.whenCommitted();
      const workloads = [
        ["focus-style", (i) => f.root.runSync(() => driver.focus((i % (d.cards - 1)) + 1))],
        [
          "imperative-opacity",
          (i) => driver.ref.current.setNativeProps({ style: { opacity: i % 2 ? 1 : 0.8 } }),
        ],
        ["declarative-opacity", (i) => f.root.runSync(() => driver.opacity(i % 2 ? 1 : 0.8))],
        [
          "imperative-width",
          (i) => driver.ref.current.setNativeProps({ style: { width: i % 2 ? 140 : 150 } }),
        ],
        ["unchanged-render", () => f.root.render(h(Tree, { ...d, driver }))],
        ["same-element-control", () => f.root.render(element)],
      ];
      for (const [name, action] of workloads) {
        for (let i = 0; i < warmup; i++) await timed(f, () => action(i));
        const observations = [];
        for (let i = 0; i < samples; i++)
          observations.push(await timed(f, () => action(i + warmup)));
        record(d, round, name, observations, f);
      }
      await retire(f, { size: d.size, round, cycle: "updates" });
    }
    for (const length of [1000, 10000]) {
      const f = fixture({ width: 400, height: 720 }),
        ref = createRef();
      const data = Array.from({ length }, (_, index) => ({ key: String(index) }));
      const renderItem = ({ index }) =>
        h(
          Pressable,
          { nativeID: `item-${index}`, onFocus: noop, style: { width: 300, height: 96 } },
          h(Text, { style: { fontSize: 20 } }, `Row ${index}`),
        );
      const element = h(FlatList, {
        ref,
        data,
        renderItem,
        keyExtractor: (item) => item.key,
        getItemLayout: (_data, index) => ({ index, length: 96, offset: index * 96 }),
        initialNumToRender: 32,
        maxToRenderPerBatch: 128,
        updateCellsBatchingPeriod: 0,
        windowSize: 3,
        showsVerticalScrollIndicator: false,
        style: { width: 400, height: 720 },
      });
      f.root.render(element);
      await f.root.whenCommitted();
      await settleList(f);
      const d = {
        size: "virtual-list",
        dataLength: length,
        viewportHeight: 720,
        itemHeight: 96,
        windowSize: 3,
        initialNumToRender: 32,
        maxToRenderPerBatch: 128,
        completion:
          "whenCommitted plus two quiet zero-delay timer turns; timer-wait overhead included",
      };
      for (let i = 0; i < warmup; i++) {
        await timed(
          f,
          () => ref.current.scrollToOffset({ offset: (i % 2 ? 100 : 500) * 96, animated: false }),
          true,
        );
      }
      const observations = [];
      for (let i = 0; i < samples; i++)
        observations.push(
          await timed(
            f,
            () => ref.current.scrollToOffset({ offset: (i % 2 ? 100 : 500) * 96, animated: false }),
            true,
          ),
        );
      const realizedItems = [...f.port.nodes.values()].filter((n) =>
        String(n.fields.id).startsWith("item-"),
      ).length;
      record({ ...d, realizedItems }, round, "virtual-list-scroll", observations, f);
      const nodes = f.port.nodes.size,
        batches = f.port.counts.batch;
      await new Promise((resolve) => setTimeout(resolve, 20));
      await f.root.whenCommitted();
      assert.equal(
        f.port.nodes.size,
        nodes,
        "List must finish its queued realization before observation",
      );
      assert.equal(
        f.port.counts.batch,
        batches,
        "List must have no deferred commit after measurement",
      );
      await retire(f, { size: "virtual-list", dataLength: length, round });
    }
  }
  const heapEnd = heap();
  writeFileSync(
    process.argv[2],
    JSON.stringify({
      schema: "rnr-host-performance/v1",
      diagnostic,
      reactVersion: version,
      node: process.version,
      v8: process.versions.v8,
      production: process.env.NODE_ENV === "production",
      samples,
      rounds,
      warmup,
      countersEnabled: count,
      timingBoundary: "public call through awaited NativeRoot.whenCommitted; no phase attribution",
      textFixture:
        "synchronous metrics: Unicode codepoint count * fontSize * 0.52; lineHeight fontSize * 1.2; no font or raster IO",
      port: "CountingPort synchronous in-memory substitution, assertions and numeric counters; no operation logs",
      heapStart,
      heapEnd,
      cleanupCycles: cleanup.length,
      cleanup: {
        allPassed: true,
        rootNodesRetained: 1,
        listenersRetained: 0,
        inputTargetsRetained: 0,
        inputObserversRetained: 0,
      },
      results,
    }) + "\n",
  );
  console.log(
    JSON.stringify({
      diagnostic,
      counters: count,
      rows: results.length,
      cleanupCycles: cleanup.length,
      largeOpacity: results
        .filter((r) => r.size === "large" && r.workload === "imperative-opacity")
        .map((r) => r.medianMs),
    }),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
