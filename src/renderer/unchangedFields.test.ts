import assert from "node:assert/strict";
import { test } from "vitest";
import { createElement as h, createRef } from "react";
import { createSceneRoot, sceneNodeReference, type SceneHandle } from "./SceneRoot";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";

function setup() {
  const graph = new RecordingSceneGraph();
  const root = createSceneRoot(graph);
  const children = (id: string) => {
    const node = [...graph.nodes.values()].find((node) => node.fields.id === id);
    assert.ok(node, id);
    return node.children;
  };
  return { graph, root, children };
}

test("updates the selected title and colors while retaining nodes and observers", () => {
  const { graph, root } = setup();
  const handler = () => undefined;
  const render = (selection: number, opacity = true) =>
    h(
      "group",
      { fields: { id: "shelf" } },
      h("label", { fields: { text: `Title ${selection}`, translation: [1, 2] } }),
      ...[0, 1, 2].map((index) =>
        h("rectangle", {
          key: index,
          fields: {
            id: `card-${index}`,
            color: index === selection ? "highlight" : "base",
            translation: [index * 10, 5],
            ...(index === 2 && opacity ? { opacity: 0.5 } : {}),
          },
          events: { selected: handler },
        }),
      ),
    );
  root.render(render(0));
  const nodes = [...graph.root.children[0].children];
  graph.operations.length = 0;
  root.render(render(1));
  assert.deepEqual(graph.root.children[0].children, nodes);
  assert.deepEqual(
    graph.operations.map(({ operation, field }) => [operation, field]),
    [
      ["set", "text"],
      ["set", "color"],
      ["set", "color"],
    ],
  );
  assert.equal(graph.listenerCount, 3);
  assert.deepEqual(
    nodes.map((node) => node.fields.text ?? node.fields.color),
    ["Title 1", "base", "highlight", "base"],
  );
  graph.operations.length = 0;
  root.render(render(1, false));
  assert.deepEqual(
    graph.operations.map(({ operation, field, value }) => [operation, field, value]),
    [["set", "opacity", null]],
  );
  root.unmount();
  assert.equal(graph.listenerCount, 0);
  assert.equal(graph.nodes.size, 1);
});

test("checks child order, parent changes, replaced listeners and unmount even with the same fields", () => {
  const { graph, root, children } = setup();
  const calls: string[] = [];
  const first = () => calls.push("old");
  const next = () => calls.push("new");
  const render = (left: string[], right: string[], handler?: () => void) => {
    const card = (id: string) =>
      h("rectangle", {
        key: id,
        fields: { id, translation: [1, 2] },
        events: handler ? { selected: handler } : {},
      });
    return h(
      "group",
      null,
      h("group", { fields: { id: "left" } }, ...left.map(card)),
      h("group", { fields: { id: "right" } }, ...right.map(card)),
    );
  };
  root.render(render(["a", "b"], [], first));
  const [a, b] = children("left");
  graph.emit(a, "selected", true);
  graph.operations.length = 0;
  root.render(render(["b", "a"], [], next));
  assert.deepEqual(children("left"), [b, a]);
  assert.ok(graph.operations.some((entry) => entry.operation === "insert"));
  assert.equal(graph.operations.filter((entry) => entry.operation === "subscribe").length, 0);
  graph.emit(a, "selected", true);
  assert.deepEqual(calls, ["old", "new"]);
  root.render(render(["b"], ["a"], next));
  assert.deepEqual(children("left"), [b]);
  const [moved] = children("right");
  assert.equal(moved.fields.id, "a");
  assert.equal(graph.nodes.has(a.id), false);
  root.render(render(["b"], ["a"]));
  assert.equal(graph.listenerCount, 0);
  graph.emit(moved, "selected", true);
  assert.deepEqual(calls, ["old", "new"]);
  root.unmount();
  assert.equal(graph.nodes.size, 1);
  assert.equal(graph.root.children.length, 0);
});

test("compares authored array snapshots and resolves tokens, raw text and hidden visibility", () => {
  const { graph, root } = setup();
  const vector = [1, 2];
  const anchor = createRef<SceneHandle>();
  const label = (text: string, linked: boolean, visible = true) =>
    h(
      "group",
      null,
      h("group", { ref: anchor }),
      h(
        "label",
        {
          fields: {
            translation: vector,
            visible,
            ...(linked ? { example: [sceneNodeReference(anchor.current!)] } : {}),
          },
        },
        text,
      ),
    );
  root.render(label("old", false));
  const node = graph.root.children[0].children[1];
  assert.deepEqual(node.fields.translation, [1, 2]);
  vector[0] = 9;
  root.render(label("new", true, false));
  assert.deepEqual(node.fields.translation, [9, 2]);
  assert.deepEqual(node.fields.example, [anchor.current!.nativeRef]);
  assert.equal(node.fields.text, "new");
  assert.equal(node.fields.visible, false);
  root.unmount();
});
