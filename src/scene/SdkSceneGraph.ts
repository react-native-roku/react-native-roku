import type { DomNode, TmValue } from "@roku-sdk/interfaces";
import { transactionManager } from "@roku-sdk/common/transaction";
import { tmTransaction } from "@roku-sdk/solid";
import {
  RokuHostError,
  type SceneFieldListener,
  type SceneGraphPort,
  type SceneNodeRef,
  type SceneValue,
} from "./sceneGraph.types";

/** All unstable SDK Tree API access stays in this device-only adapter. */
export class SdkSceneGraph implements SceneGraphPort {
  readonly root: SceneNodeRef;
  private nextId = 0;
  private readonly nativeNodes = new Map<SceneNodeRef, DomNode>();
  private readonly issuedRefs = new WeakSet<object>();

  private focusSampleSequence = 0;
  private releaseFocusSample?: () => void;

  constructor(
    container: DomNode,
    private readonly focusControl?: DomNode,
  ) {
    this.root = this.retain(container);
  }
  cancelFocusSample(): void {
    this.releaseFocusSample?.();
  }
  sampleFocus(nodes: readonly SceneNodeRef[], receive: (node: SceneNodeRef) => void): void {
    const control = this.focusControl;
    if (!control) return;
    this.releaseFocusSample?.();
    const ticket = ++this.focusSampleSequence;
    const property = "onFocusSampleReply";
    const listener = (value: unknown) => {
      if (typeof value !== "string") return;
      const [sequence, index] = value.split(":").map(Number);
      if (sequence !== ticket) return;
      release();
      if (nodes[index]) receive(nodes[index]);
    };
    const release = () => {
      if (this.releaseFocusSample !== release) return;
      this.releaseFocusSample = undefined;
      clearTimeout(timer);
      this.batch(() =>
        tmTransaction.setProperty(control, property, null as unknown as TmValue, listener),
      );
    };
    const timer = setTimeout(release, 250);
    this.releaseFocusSample = release;
    this.batch(() => {
      tmTransaction.setProperty(control, property, listener);
      tmTransaction.setProperty(control, "focusSampleTarget", this.native(nodes[0]));
      if (nodes[1])
        tmTransaction.setProperty(control, "focusSamplePrevious", this.native(nodes[1]));
      tmTransaction.setProperty(control, "focusSampleTicket", ticket);
    });
  }
  create(type: string): SceneNodeRef {
    return this.retain(tmTransaction.createElement(type));
  }
  set(node: SceneNodeRef, field: string, value: SceneValue): void {
    // The SDK coerces a cleared float to zero. SceneGraph opacity defaults to one.
    const nativeValue = field === "opacity" && value === null ? 1 : value;
    tmTransaction.setProperty(this.native(node), field, this.convert(nativeValue) as TmValue);
  }
  insert(parent: SceneNodeRef, child: SceneNodeRef, before?: SceneNodeRef): void {
    const nativeParent = this.native(parent),
      nativeChild = this.native(child);
    // The SDK maintains parent.c for same-parent moves only. Detach a moved node
    // from the old bookkeeping tree before insertion cancels deferred removal.
    if (nativeChild.parent && nativeChild.parent !== nativeParent)
      tmTransaction.removeNode(nativeChild.parent, nativeChild);
    tmTransaction.insertNode(nativeParent, nativeChild, before && this.native(before));
  }
  remove(parent: SceneNodeRef, child: SceneNodeRef): void {
    const nativeChild = this.native(child);
    tmTransaction.removeNode(this.native(parent), nativeChild);
    const retired = new Set<DomNode>();
    const visit = (node: DomNode) => {
      retired.add(node);
      for (const descendant of node.c ?? []) visit(descendant);
    };
    visit(nativeChild);
    for (const [ref, native] of this.nativeNodes)
      if (retired.has(native)) this.nativeNodes.delete(ref);
  }
  subscribe(node: SceneNodeRef, field: string, listener: SceneFieldListener): () => void {
    const native = this.native(node);
    const property = `on${field.charAt(0).toUpperCase()}${field.slice(1)}`;
    tmTransaction.setProperty(native, property, listener as TmValue);
    return () => {
      tmTransaction.setProperty(native, property, null as unknown as TmValue, listener as TmValue);
    };
  }
  batch(work: () => void): void {
    transactionManager.startTransaction();
    work();
  }
  native(ref: SceneNodeRef): DomNode {
    const node = this.nativeNodes.get(ref);
    if (!node) throw new RokuHostError("STALE_NODE", `Unknown or retired SDK node ${ref.id}`);
    return node;
  }
  private retain(node: DomNode): SceneNodeRef {
    const ref = Object.freeze({ id: ++this.nextId, type: node.t ?? "anchor" });
    this.issuedRefs.add(ref);
    this.nativeNodes.set(ref, node);
    return ref;
  }
  private convert(value: unknown): unknown {
    if (value && typeof value === "object" && this.issuedRefs.has(value))
      return this.native(value as SceneNodeRef);
    if (Array.isArray(value)) return value.map((item) => this.convert(item));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.convert(item)]),
      );
    return value;
  }
}
