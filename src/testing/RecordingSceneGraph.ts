import {
  RokuHostError,
  type SceneFieldListener,
  type SceneGraphPort,
  type SceneNodeRef,
  type SceneValue,
} from "../scene/sceneGraph.types";

export interface RecordedSceneNode extends SceneNodeRef {
  readonly fields: Record<string, SceneValue>;
  readonly children: RecordedSceneNode[];
  parent: RecordedSceneNode | null;
}

/** Host conformance adapter; its output is never device or performance evidence. */
export class RecordingSceneGraph implements SceneGraphPort {
  readonly root: RecordedSceneNode = {
    id: 0,
    type: "root",
    fields: {},
    children: [],
    parent: null,
  };
  readonly operations: Array<{
    operation: string;
    node: number;
    field?: string;
    value?: unknown;
  }> = [];
  readonly nodes = new Map<number, RecordedSceneNode>([[0, this.root]]);
  private nextId = 0;
  private readonly listeners = new Map<string, Set<SceneFieldListener>>();
  hostCommits = 0;

  create(type: string): RecordedSceneNode {
    const node: RecordedSceneNode = {
      id: ++this.nextId,
      type,
      fields: {},
      children: [],
      parent: null,
    };
    this.nodes.set(node.id, node);
    this.operations.push({ operation: "create", node: node.id, value: type });
    return node;
  }

  set(ref: SceneNodeRef, field: string, value: SceneValue): void {
    const node = this.lookup(ref);
    node.fields[field] = value;
    this.operations.push({ operation: "set", node: node.id, field, value });
  }

  insert(parentRef: SceneNodeRef, childRef: SceneNodeRef, beforeRef?: SceneNodeRef): void {
    const parent = this.lookup(parentRef),
      child = this.lookup(childRef);
    if (parent === child) throw new RokuHostError("TREE_CYCLE", "A node cannot own itself");
    for (let ancestor: RecordedSceneNode | null = parent; ancestor; ancestor = ancestor.parent) {
      if (ancestor === child)
        throw new RokuHostError("TREE_CYCLE", "Cannot attach an ancestor as a child");
    }
    if (beforeRef?.id === child.id) return;
    const before = beforeRef && this.lookup(beforeRef);
    if (before && before.parent !== parent)
      throw new RokuHostError("TREE_ANCHOR", "Insertion anchor has another parent");
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    parent.children.splice(
      before ? parent.children.indexOf(before) : parent.children.length,
      0,
      child,
    );
    child.parent = parent;
    this.operations.push({
      operation: "insert",
      node: child.id,
      value: { parent: parent.id, before: before?.id },
    });
  }

  remove(parentRef: SceneNodeRef, childRef: SceneNodeRef): void {
    const parent = this.lookup(parentRef),
      child = this.lookup(childRef);
    if (child.parent !== parent)
      throw new RokuHostError("TREE_PARENT", "Removal parent does not own the node");
    parent.children.splice(parent.children.indexOf(child), 1);
    const retire = (node: RecordedSceneNode) => {
      for (const descendant of [...node.children]) retire(descendant);
      for (const key of this.listeners.keys())
        if (key.startsWith(`${node.id}:`)) this.listeners.delete(key);
      this.nodes.delete(node.id);
      node.parent = null;
    };
    retire(child);
    this.operations.push({ operation: "remove", node: child.id });
  }

  subscribe(ref: SceneNodeRef, field: string, listener: SceneFieldListener): () => void {
    this.lookup(ref);
    const key = `${ref.id}:${field}`;
    const callbacks = this.listeners.get(key) ?? new Set();
    callbacks.add(listener);
    this.listeners.set(key, callbacks);
    return () => {
      callbacks.delete(listener);
      if (callbacks.size === 0) this.listeners.delete(key);
    };
  }

  emit(ref: SceneNodeRef, field: string, value: unknown): void {
    if (!this.nodes.has(ref.id)) return;
    for (const listener of [...(this.listeners.get(`${ref.id}:${field}`) ?? [])]) listener(value);
  }

  batch(work: () => void): void {
    work();
    this.hostCommits++;
  }
  get listenerCount(): number {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  }

  snapshot(node = this.root): unknown {
    return {
      type: node.type,
      fields: { ...node.fields },
      children: node.children.map((child) => this.snapshot(child)),
    };
  }

  private lookup(ref: SceneNodeRef): RecordedSceneNode {
    const node = this.nodes.get(ref.id);
    if (!node || node !== ref)
      throw new RokuHostError("STALE_NODE", `Unknown or retired node ${ref.id}`);
    return node;
  }
}
