import { createContext, version as reactVersion, type ReactNode } from "react";
import Reconciler from "react-reconciler";
import { ConcurrentRoot, DefaultEventPriority, NoEventPriority } from "react-reconciler/constants";
import {
  RokuHostError,
  type SceneFields,
  type SceneFieldListener,
  type SceneGraphPort,
  type SceneNodeRef,
} from "../scene/sceneGraph.types";

export interface SceneElementProps {
  readonly children?: ReactNode;
  readonly fields?: SceneFields;
  readonly events?: Readonly<Record<string, SceneFieldListener>>;
  readonly layout?: Readonly<Record<string, unknown>>;
  readonly backgroundFields?: SceneFields;
}

export interface SceneTreeElement {
  readonly kind: "element";
  readonly hidden?: boolean;
  readonly type: string;
  readonly props: SceneElementProps;
  readonly handle: SceneHandle;
  readonly children: readonly (
    SceneTreeElement | { readonly kind: "text"; readonly text: string; readonly hidden: boolean }
  )[];
}

export interface SceneRootOptions {
  /** Opt into React's development StrictMode effect/ref replay at the root. */
  strictMode?: boolean;
  prepareFields?(
    tree: readonly SceneTreeElement[],
    reactCommit?: boolean,
  ):
    | ReadonlyMap<SceneTreeElement, SceneFields>
    | Promise<ReadonlyMap<SceneTreeElement, SceneFields>>;
  /** Layout owns line fields; the reconciler owns their native lifetime. */
  inlineTextLines?(node: SceneTreeElement): readonly SceneFields[];
  afterCommit?(tree: readonly SceneTreeElement[]): void;
}

type PreparedFields = ReadonlyMap<SceneTreeElement, SceneFields>;
type SceneChanges = ReadonlySet<SceneTreeElement>;
interface PreparedSceneRootOptions extends SceneRootOptions {
  prepareFields?(
    tree: readonly SceneTreeElement[],
    reactCommit?: boolean,
    changes?: SceneChanges,
  ): PreparedFields | Promise<PreparedFields>;
}

const stableGeometry = new WeakMap<PreparedFields, Map<SceneTreeElement, SceneFields> | null>();
const generatedFields = new WeakSet<SceneFields>();

/** Only the native layout owner can attest that it reused the committed geometry. */
export function reuseSceneGeometry(
  fields: PreparedFields,
  base?: Map<SceneTreeElement, SceneFields>,
): void {
  stableGeometry.set(fields, base ?? null);
}

/** Renderer-owned scalar inputs, detached from application objects. */
export function generatedSceneFields<T extends Readonly<Record<string, boolean | number | string>>>(
  fields: T,
): T {
  generatedFields.add(fields);
  return Object.freeze(fields);
}

export interface SceneHandle {
  readonly nativeRef: SceneNodeRef | null;
}

interface TextNode {
  readonly kind: "text";
  text: string;
  hidden: boolean;
}
interface ElementNode {
  readonly kind: "element";
  readonly type: string;
  props: SceneElementProps;
  readonly children: HostChild[];
  background?: ElementNode;
  readonly handle: SceneHandle;
  ref: SceneNodeRef | null;
  hidden: boolean;
  appliedFields: SceneFields;
  appliedAuthoredFields?: SceneFields;
  appliedEvents?: SceneElementProps["events"];
  inlineLines: { ref: SceneNodeRef; fields: SceneFields }[];
  readonly subscriptions: Map<string, () => void>;
}
type HostChild = ElementNode | TextNode;
interface Parent {
  readonly children: HostChild[];
}
interface RootState extends Parent {
  readonly port: SceneGraphPort;
  realized: Map<ElementNode, SceneNodeRef>;
  parents: Map<ElementNode, SceneNodeRef>;
  orders: Map<SceneNodeRef, SceneNodeRef[]>;
  commit(reactCommit?: boolean, changes?: SceneChanges): void;
  error: Error | null;
  errorGeneration: number;
  errorKind: "native" | "react" | null;
  generation: number;
  pending: Promise<void>;
  focusPresentation?: { nodes: Set<ElementNode>; timer: ReturnType<typeof setTimeout> };
}

const HOST_TYPES = new Set([
  "group",
  "rectangle",
  "label",
  "multiStyleLabel",
  "inlineText",
  "poster",
  "font",
  "video",
  "audio",
  "contentNode",
  "effect",
  "maskGroup",
]);
const references = new WeakMap<object, SceneHandle>();
const elementsByHandle = new WeakMap<SceneHandle, ElementNode>();
const opacityUpdates = new WeakMap<SceneRoot, (handle: SceneHandle, value: number) => boolean>();

export type FocusPresentationWrite = {
  readonly node: SceneTreeElement;
  readonly fields: Readonly<{ color: string } | { text: string; numLines: number }>;
};
const focusPresentations = new WeakMap<
  SceneRoot,
  (target: SceneTreeElement, writes: readonly FocusPresentationWrite[]) => boolean
>();

/** Submit layout-owner-approved fields without synthesizing a focus observation. */
export function trySubmitFocusPresentation(
  root: SceneRoot,
  target: SceneTreeElement,
  writes: readonly FocusPresentationWrite[],
): boolean {
  return focusPresentations.get(root)?.(target, writes) ?? false;
}

/** Internal native-host bridge. Decline unless the entire native commit is stable. */
export function tryUpdateCommittedOpacity(
  root: SceneRoot,
  handle: SceneHandle,
  value: number,
): boolean {
  return opacityUpdates.get(root)?.(handle, value) ?? false;
}

export function sceneNodeReference(handle: SceneHandle): Readonly<Record<string, unknown>> {
  const token = Object.freeze({});
  references.set(token, handle);
  return token;
}
function resolveReferences(value: unknown): unknown {
  if (value && typeof value === "object" && references.has(value)) {
    const ref = references.get(value)!.nativeRef;
    if (!ref)
      throw new RokuHostError("TREE_REFERENCE", "A field references an unrealized scene node");
    return ref;
  }
  if (Array.isArray(value)) return value.map(resolveReferences);
  if (value && typeof value === "object" && !("id" in value && "type" in value))
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveReferences(entry)]),
    );
  return value;
}
const EMPTY_CONTEXT = Object.freeze({});
const ACTIVATION_FIELDS = new Set(["uri", "maskUri", "control"]);
let currentPriority: Reconciler.EventPriority = NoEventPriority;

function equalField(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (depth > 32 || !a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => equalField(item, b[index], depth + 1))
    );
  // Scene node references are capabilities, so retain their identity semantics.
  if (("id" in a && "type" in a) || ("id" in b && "type" in b)) return false;
  const entries = Object.entries(a),
    record = b as Record<string, unknown>;
  return (
    entries.length === Object.keys(b).length &&
    entries.every(
      ([key, value]) => Object.hasOwn(b, key) && equalField(value, record[key], depth + 1),
    )
  );
}

// The applied fields contain resolved values and snapshots of authored arrays.
// Reference tokens and general compound values need the full resolution path.
function sameScalarFieldInputs(fields: SceneFields, applied: SceneFields): boolean {
  const keys = Object.keys(fields);
  if (keys.length !== Object.keys(applied).length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(applied, key)) return false;
    const value = fields[key],
      previous = applied[key];
    if (Array.isArray(value)) {
      if (
        !Array.isArray(previous) ||
        value.length !== previous.length ||
        Object.getPrototypeOf(value) !== Array.prototype ||
        Object.hasOwn(value, "constructor") ||
        Object.hasOwn(value, "map")
      )
        return false;
      for (let i = 0; i < value.length; i++) {
        const item: unknown = value[i];
        if (
          !Object.hasOwn(value, i) ||
          (item !== null && typeof item === "object") ||
          !Object.is(item, previous[i])
        )
          return false;
      }
    } else if (!Object.is(value, previous)) {
      return false;
    } else if (
      value &&
      typeof value === "object" &&
      (references.has(value) || !("id" in value && "type" in value))
    ) {
      return false;
    }
  }
  return true;
}

const textParents = new WeakMap<TextNode, ElementNode | RootState>();
// React performs the mutation phase synchronously between these two commit hooks.
let mutations: { structural: boolean; nodes: Set<SceneTreeElement> } | undefined;

function noteStructureChange(): void {
  if (mutations) mutations.structural = true;
}

function insert(parent: ElementNode | RootState, child: HostChild, before?: HostChild): void {
  if (before === child) return;
  const existing = parent.children.indexOf(child);
  if (existing >= 0) parent.children.splice(existing, 1);
  const index = before ? parent.children.indexOf(before) : parent.children.length;
  if (index < 0)
    throw new RokuHostError("TREE_ANCHOR", "React requested an absent insertion anchor");
  parent.children.splice(index, 0, child);
  if (child.kind === "text") textParents.set(child, parent);
}

function insertCommitted(
  parent: ElementNode | RootState,
  child: HostChild,
  before?: HostChild,
): void {
  noteStructureChange();
  insert(parent, child, before);
}

function remove(parent: Parent, child: HostChild): void {
  const index = parent.children.indexOf(child);
  if (index < 0)
    throw new RokuHostError("TREE_PARENT", "React requested removal from an unrelated parent");
  parent.children.splice(index, 1);
  if (child.kind === "text" && textParents.get(child) === parent) textParents.delete(child);
  noteStructureChange();
}

function updateFields(
  root: RootState,
  child: ElementNode,
  ref: SceneNodeRef,
  layoutFields: SceneFields | undefined,
): SceneFields | undefined {
  const { port } = root;
  const authored = child.props.fields;
  const inputs = { ...authored, ...layoutFields };
  const rawLabel =
    child.type === "label" && child.children.length > 0 && !("text" in (layoutFields ?? {}));
  const hasVisibility = !["font", "contentNode", "effect", "audio"].includes(child.type);
  // Only fold visibility into the raw input when it needs no reference resolution.
  const simpleVisibility = inputs.visible == null || typeof inputs.visible !== "object";
  const reuse = !rawLabel && simpleVisibility && (!("id" in inputs) || !("type" in inputs));
  if (reuse && hasVisibility) inputs.visible = !child.hidden && inputs.visible !== false;
  let fields: Record<string, import("../scene/sceneGraph.types").SceneValue> | undefined;
  if (!reuse || !sameScalarFieldInputs(inputs, child.appliedFields)) {
    fields = resolveReferences(inputs) as Record<
      string,
      import("../scene/sceneGraph.types").SceneValue
    >;
    if (rawLabel) {
      if (child.children.some((item) => item.kind !== "text"))
        throw new RokuHostError("LABEL_CHILD", "Raw SceneGraph labels admit text children only");
      fields = {
        ...fields,
        text: child.children
          .map((item) => (item.kind === "text" && !item.hidden ? item.text : ""))
          .join(""),
      };
    }
    if (!reuse && hasVisibility)
      fields = {
        ...fields,
        visible: !child.hidden && fields.visible !== false,
      };
    for (const field of Object.keys(child.appliedFields))
      if (!(field in fields)) port.set(ref, field, null);
    // Loading/playing can begin as soon as these fields are written. Install
    // subscriptions and geometry first, including for cached local images.
    for (const [field, value] of Object.entries(fields)) {
      if (ACTIVATION_FIELDS.has(field)) continue;
      if (!equalField(value, child.appliedFields[field])) port.set(ref, field, value);
    }
  }
  const eventInputs = child.props.events;
  const events = eventInputs ?? {};
  for (const [field, unsubscribe] of child.subscriptions) {
    if (!(field in events)) {
      unsubscribe();
      child.subscriptions.delete(field);
    }
  }
  for (const field of Object.keys(events)) {
    if (!child.subscriptions.has(field)) {
      child.subscriptions.set(
        field,
        port.subscribe(ref, field, (value) => {
          if (child.ref === ref && root.realized.get(child) === ref)
            child.props.events?.[field]?.(value);
        }),
      );
    }
  }
  child.appliedAuthoredFields = authored;
  child.appliedEvents = eventInputs;
  return fields;
}

function applyActivationFields(
  port: SceneGraphPort,
  child: ElementNode,
  ref: SceneNodeRef,
  fields: SceneFields | undefined,
): void {
  if (!fields) return;
  for (const field of ACTIVATION_FIELDS)
    if (field in fields && !equalField(fields[field], child.appliedFields[field]))
      port.set(ref, field, fields[field]);
  child.appliedFields = fields;
}

/** These generated host nodes carry immutable scalar native inputs. */
export function hasGeneratedSceneFields(node: SceneTreeElement): boolean {
  const { fields, events } = node.props;
  return (
    !!fields &&
    generatedFields.has(fields) &&
    (!events || Object.isFrozen(events)) &&
    (node.type === "group" ||
      node.type === "rectangle" ||
      node.type === "label" ||
      (node.type === "poster" && node.props.layout === plainImageLayout))
  );
}

function commitStableFields(
  root: RootState,
  previous: PreparedFields,
  prepared: PreparedFields,
  changes: SceneChanges,
  sparse: boolean,
): boolean {
  if ((sparse ? previous : prepared).size !== root.realized.size) return false;
  const affected: ElementNode[] = [];
  // Full commits retain nodes in native sibling order. Keep that write order
  // without allocating nodes, sorting siblings or rebuilding the ownership maps.
  for (const node of root.realized.keys()) {
    const previewed = root.focusPresentation?.nodes.has(node);
    const changed = prepared.get(node);
    if (sparse && !changed && !previewed && !changes.has(node)) continue;
    const before = previous.get(node);
    const next = changed ?? (sparse ? before : undefined);
    if (!hasGeneratedSceneFields(node) || !next || !before) return false;
    if (root.focusPresentation) {
      const inputs = { ...node.props.fields, ...next };
      if (inputs.visible == null || typeof inputs.visible !== "object")
        inputs.visible = !node.hidden && inputs.visible !== false;
      const events = Object.keys(node.props.events ?? {});
      if (
        (node.type !== "label" || "text" in next) &&
        !("type" in inputs && "id" in inputs) &&
        sameScalarFieldInputs(inputs, node.appliedFields) &&
        events.length === node.subscriptions.size &&
        events.every((field) => node.subscriptions.has(field))
      )
        continue;
    }
    // A prepared change may come from a different node or from native font
    // readiness. A reconciler mutation alone is insufficient to identify it.
    const authored = node.props.fields!;
    const applied = node.appliedAuthoredFields;
    const authoredChanged =
      changes.has(node) &&
      (!applied ||
        !generatedFields.has(applied) ||
        node.props.events !== node.appliedEvents ||
        (node.type === "label" && !("text" in next)) ||
        (authored !== applied && !sameScalarFieldInputs(authored, applied)));
    if (previewed || authoredChanged || (next !== before && !sameScalarFieldInputs(next, before)))
      affected.push(node);
  }
  if (affected.length)
    root.port.batch(() => {
      for (const node of affected) {
        const ref = root.realized.get(node)!;
        applyActivationFields(
          root.port,
          node,
          ref,
          updateFields(
            root,
            node,
            ref,
            prepared.get(node) ?? (sparse ? previous.get(node) : undefined),
          ),
        );
      }
    });
  return true;
}

function commitTree(
  root: RootState,
  prepared: ReadonlyMap<SceneTreeElement, SceneFields> = new Map(),
  inlineTextLines?: SceneRootOptions["inlineTextLines"],
): void {
  const { port } = root;
  const realized = new Map<ElementNode, SceneNodeRef>(),
    parents = new Map<ElementNode, SceneNodeRef>();
  const orders = new Map<SceneNodeRef, SceneNodeRef[]>();
  port.batch(() => {
    const allocate = (parent: Parent) => {
      for (const child of parent.children)
        if (child.kind === "element") {
          child.ref ??= port.create(child.type === "inlineText" ? "group" : child.type);
          if (
            child.type !== "label" &&
            child.type !== "multiStyleLabel" &&
            child.type !== "inlineText" &&
            !child.props.layout?.textRaster
          )
            allocate(child);
        }
    };
    allocate(root);
    const visit = (parent: Parent, parentRef: SceneNodeRef) => {
      const children = parent.children
        .filter((child): child is ElementNode => child.kind === "element")
        .map((node, index) => ({
          node,
          index,
          z: Number((node.props.layout?.style as Record<string, unknown> | undefined)?.zIndex ?? 0),
        }))
        .sort((a, b) => a.z - b.z || a.index - b.index)
        .map((entry) => entry.node);
      for (const child of parent.children) {
        if (child.kind === "text" && child.text.trim())
          throw new RokuHostError("RAW_TEXT", "Scene text must be inside a label");
      }
      for (const child of children) {
        const ref = (child.ref ??= port.create(child.type === "inlineText" ? "group" : child.type));
        realized.set(child, ref);
        parents.set(child, parentRef);
        const fields = updateFields(root, child, ref, prepared.get(child));
        if (child.type === "inlineText") {
          const lines = inlineTextLines?.(child);
          if (!lines)
            throw new RokuHostError(
              "C04_INLINE_LAYOUT",
              "Inline paragraphs require measured native lines",
            );
          const previous = child.inlineLines;
          child.inlineLines = lines.map((fields, index) => {
            const line = previous[index] ?? { ref: port.create("multiStyleLabel"), fields: {} };
            for (const name of Object.keys(line.fields))
              if (!(name in fields)) port.set(line.ref, name, null);
            for (const [name, value] of Object.entries(fields))
              if (!equalField(value, line.fields[name])) port.set(line.ref, name, value);
            if (!previous[index]) port.insert(ref, line.ref);
            line.fields = fields;
            return line;
          });
          for (const line of previous.slice(lines.length)) port.remove(ref, line.ref);
          orders.set(
            ref,
            child.inlineLines.map((line) => line.ref),
          );
        } else if (
          child.type !== "label" &&
          child.type !== "multiStyleLabel" &&
          !child.props.layout?.textRaster
        )
          visit(child, ref);
        applyActivationFields(port, child, ref, fields);
      }
      // Reparent/reorder live nodes before removing obsolete ancestors.
      const order = children.map((child) => child.ref!);
      orders.set(parentRef, order);
      const previous = root.orders.get(parentRef);
      if (
        !previous ||
        previous.length !== order.length ||
        previous.some((ref, index) => ref !== order[index])
      ) {
        const desired = new Set(order),
          working = previous?.filter((ref) => desired.has(ref)) ?? [];
        let before: SceneNodeRef | undefined;
        for (let index = order.length - 1; index >= 0; index--) {
          const ref = order[index],
            current = working.indexOf(ref);
          if (current < 0 || working[current + 1] !== before) {
            port.insert(parentRef, ref, before);
            if (current >= 0) working.splice(current, 1);
            const position = before ? working.indexOf(before) : working.length;
            working.splice(position, 0, ref);
          }
          before = ref;
        }
      }
    };
    visit(root, port.root);
    const liveRefs = new Set(realized.values());
    // Stop decoders before removing any ancestor (ports may retire descendants
    // immediately). A write requests release; it is not a stop acknowledgement.
    for (const [node, ref] of root.realized)
      if (!realized.has(node) && (node.type === "video" || node.type === "audio"))
        port.set(ref, "control", "stop");
    for (const [node, ref] of root.realized) {
      if (realized.has(node)) continue;
      for (const unsubscribe of node.subscriptions.values()) unsubscribe();
      node.subscriptions.clear();
      const parentRef = root.parents.get(node)!;
      if (parentRef === port.root || liveRefs.has(parentRef)) port.remove(parentRef, ref);
      node.ref = null;
      node.inlineLines = [];
    }
  });
  root.realized = realized;
  root.parents = parents;
  root.orders = orders;
}

type HostConfig = Reconciler.HostConfig<
  string,
  SceneElementProps,
  RootState,
  ElementNode,
  TextNode,
  never,
  never,
  never,
  SceneHandle,
  Readonly<Record<string, never>>,
  never,
  ReturnType<typeof setTimeout>,
  -1,
  null
>;

declare const __DEV__: boolean;

// Plain group paint has the same placement and lifetime as a decoration
// child, without scheduling a separate React element for every style callback.
export const plainBackgroundLayout = Object.freeze({ decoration: "background" });
// A square-corner Image poster paints inside its semantic wrapper.
export const plainImageLayout = Object.freeze({ decoration: "background" });

function sceneNode(type: string, props: SceneElementProps): ElementNode {
  const node: ElementNode = {
    kind: "element",
    type,
    props,
    children: [],
    ref: null,
    hidden: false,
    appliedFields: {},
    inlineLines: [],
    subscriptions: new Map(),
    handle: {
      get nativeRef() {
        return node.ref;
      },
    },
  };
  elementsByHandle.set(node.handle, node);
  return node;
}

function updateBackground(node: ElementNode, fields: SceneFields | undefined): void {
  const background = node.background;
  if (fields && background) {
    if (background.props.fields !== fields) {
      background.props = { fields, layout: plainBackgroundLayout };
      mutations?.nodes.add(background);
    }
    return;
  }
  if (fields) {
    const background = sceneNode("rectangle", { fields, layout: plainBackgroundLayout });
    node.background = background;
    node.children.unshift(background);
    noteStructureChange();
  } else if (background) {
    node.background = undefined;
    remove(node, background);
  }
}

const configuration: HostConfig & { rendererVersion: string; rendererPackageName: string } = {
  rendererVersion: reactVersion,
  rendererPackageName: "react-native-roku",
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  createInstance(type, props) {
    if (!HOST_TYPES.has(type))
      throw new RokuHostError("UNSUPPORTED_NODE", `Scene node ${type} has no admitted renderer`);
    const node = sceneNode(type, props);
    updateBackground(node, props.backgroundFields);
    return node;
  },
  createTextInstance: (text) => ({ kind: "text", text, hidden: false }),
  appendInitialChild: insert,
  finalizeInitialChildren: () => false,
  shouldSetTextContent: () => false,
  getRootHostContext: () => EMPTY_CONTEXT,
  getChildHostContext: (context) => context,
  getPublicInstance: (instance) =>
    instance.kind === "element" ? instance.handle : { nativeRef: null },
  prepareForCommit: () => {
    mutations = { structural: false, nodes: new Set() };
    return null;
  },
  resetAfterCommit(root) {
    const changes = mutations;
    mutations = undefined;
    root.commit(true, changes?.structural === false ? changes.nodes : undefined);
  },
  preparePortalMount: () => undefined,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,
  supportsMicrotasks: true,
  scheduleMicrotask: (callback) => {
    void Promise.resolve().then(callback);
  },
  getInstanceFromNode: () => null,
  beforeActiveInstanceBlur: () => undefined,
  afterActiveInstanceBlur: () => undefined,
  prepareScopeUpdate: () => {
    throw new RokuHostError("UNSUPPORTED_SCOPE", "React Scope requires an adapter");
  },
  getInstanceFromScope: () => null,
  detachDeletedInstance: () => undefined,
  appendChild: insertCommitted,
  appendChildToContainer: insertCommitted,
  insertBefore: insertCommitted,
  insertInContainerBefore: insertCommitted,
  removeChild: remove,
  removeChildFromContainer: remove,
  resetTextContent: (node) => {
    noteStructureChange();
    node.children.length = 0;
  },
  commitTextUpdate: (node, _previous, text) => {
    const parent = textParents.get(node);
    if (parent && "kind" in parent && parent.type === "label") mutations?.nodes.add(parent);
    else noteStructureChange();
    node.text = text;
  },
  commitUpdate: (node, _type, _previous, props) => {
    mutations?.nodes.add(node);
    if (node.background || props.backgroundFields) updateBackground(node, props.backgroundFields);
    node.props = props;
  },
  hideInstance: (node) => {
    noteStructureChange();
    node.hidden = true;
  },
  hideTextInstance: (node) => {
    noteStructureChange();
    node.hidden = true;
  },
  unhideInstance: (node) => {
    noteStructureChange();
    node.hidden = false;
  },
  unhideTextInstance: (node) => {
    noteStructureChange();
    node.hidden = false;
  },
  clearContainer: (root) => {
    noteStructureChange();
    root.children.length = 0;
  },
  NotPendingTransition: null,
  HostTransitionContext: createContext(null) as unknown as HostConfig["HostTransitionContext"],
  setCurrentUpdatePriority: (priority) => {
    currentPriority = priority;
  },
  getCurrentUpdatePriority: () => currentPriority,
  resolveUpdatePriority: () => currentPriority || DefaultEventPriority,
  resetFormInstance: () => {
    throw new RokuHostError("UNSUPPORTED_FORM", "DOM forms are not SceneGraph nodes");
  },
  // React scheduling/profiling callback; this does not acknowledge physical presentation.
  requestPostPaintCallback: (callback) => {
    setTimeout(() => callback(Date.now()), 0);
  },
  shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent: () => undefined,
  resolveEventType: () => null,
  resolveEventTimeStamp: () => Date.now(),
  maySuspendCommit: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: () => undefined,
  suspendInstance: () => undefined,
  waitForCommitToBeReady: () => null,
};

const reconciler = Reconciler(configuration);
if (typeof __DEV__ !== "undefined" && __DEV__) {
  // Pinned reconciler 0.33 reads identity from HostConfig and takes no argument.
  // Its published type still describes the preceding DevTools API.
  (reconciler.injectIntoDevTools as unknown as () => boolean)();
}

export interface SceneRoot {
  portal(element: ReactNode, key: string): ReactNode;
  render(element: ReactNode): void;
  runSync(work: () => void): void;
  flush(): void;
  refreshNative(): void;
  whenCommitted(): Promise<void>;
  unmount(): void;
  readonly mounted: boolean;
}

export function createSceneRoot(
  port: SceneGraphPort,
  onError: (error: Error, kind: "uncaught" | "caught" | "recoverable") => void = () => undefined,
  options: SceneRootOptions = {},
): SceneRoot {
  return createPreparedSceneRoot(port, onError, options);
}

export function createPreparedSceneRoot(
  port: SceneGraphPort,
  onError: (error: Error, kind: "uncaught" | "caught" | "recoverable") => void = () => undefined,
  options: PreparedSceneRootOptions = {},
): SceneRoot {
  let mounted = true;
  let retiring = false;
  let syncDepth = 0;
  let committedGeneration = -1;
  let committedFields: PreparedFields | undefined;
  const state: RootState = {
    port,
    children: [],
    realized: new Map(),
    parents: new Map(),
    orders: new Map(),
    error: null,
    errorGeneration: -1,
    errorKind: null,
    generation: 0,
    pending: Promise.resolve(),
    commit(reactCommit = false, changes) {
      const generation = ++state.generation;
      const tree = state.children.filter((child): child is ElementNode => child.kind === "element");
      const apply = (fields: ReadonlyMap<SceneTreeElement, SceneFields>) => {
        if (generation !== state.generation) return;
        const preview = state.focusPresentation;
        const base = stableGeometry.get(fields);
        if (
          !changes ||
          !committedFields ||
          committedGeneration !== generation - 1 ||
          !stableGeometry.has(fields) ||
          (base != null && base !== committedFields) ||
          !commitStableFields(state, committedFields, fields, changes, base != null)
        ) {
          const complete = base ? new Map(base) : undefined;
          if (complete) for (const [node, next] of fields) complete.set(node, next);
          commitTree(state, complete ?? fields, options.inlineTextLines);
        }
        if (base) {
          if (generation !== state.generation) return;
          for (const [node, next] of fields) base.set(node, next);
        }
        if (preview && state.focusPresentation === preview) {
          clearTimeout(preview.timer);
          state.focusPresentation = undefined;
        }
        options.afterCommit?.(tree);
        committedGeneration = generation;
        committedFields = base ?? fields;
        if (
          !retiring &&
          state.errorGeneration < generation &&
          (state.errorKind !== "react" || reactCommit)
        ) {
          state.error = null;
          state.errorKind = null;
        }
      };
      const fail = (error: unknown) => {
        if (generation !== state.generation) return;
        state.error = error instanceof Error ? error : new Error(String(error));
        state.errorGeneration = generation;
        state.errorKind = "native";
        onError(state.error, "uncaught");
        throw state.error;
      };
      try {
        const settledChanges =
          committedGeneration === generation - 1 && !state.error ? changes : undefined;
        const prepared = options.prepareFields?.(tree, reactCommit, settledChanges) ?? new Map();
        if (prepared instanceof Promise) state.pending = prepared.then(apply).catch(fail);
        else {
          apply(prepared);
          state.pending = Promise.resolve();
        }
      } catch (error) {
        // React may commit a query/store update outside a caller's runSync.
        // Keep preparation failures on the same observed error channel as
        // asynchronous font/layout failures instead of throwing from a task.
        state.pending = Promise.resolve().then(() => fail(error));
      }
      // Surface through whenCommitted/onError, without an unhandled background rejection.
      void state.pending.catch(() => undefined);
    },
  };
  const container = reconciler.createContainer(
    state,
    ConcurrentRoot,
    null,
    options.strictMode ?? false,
    null,
    "roku-",
    (error) => {
      state.error = error;
      state.errorGeneration = state.generation;
      state.errorKind = "react";
      onError(error, "uncaught");
    },
    (error) => onError(error, "caught"),
    (error) => onError(error, "recoverable"),
    () => undefined,
  );
  const flush = () => {
    syncDepth++;
    try {
      reconciler.flushSyncWork();
      reconciler.flushPassiveEffects();
    } finally {
      syncDepth--;
    }
    if (state.error) {
      const error = state.error;
      state.error = null;
      throw error;
    }
  };
  const assertMounted = () => {
    if (!mounted) throw new RokuHostError("RETIRED_ROOT", "A retired React root cannot be reused");
  };
  const root: SceneRoot = {
    portal(element, key) {
      assertMounted();
      return reconciler.createPortal(element, state, null, key) as unknown as ReactNode;
    },
    render(element) {
      assertMounted();
      reconciler.updateContainerSync(element, container, null, null);
      flush();
    },
    runSync(work) {
      assertMounted();
      if (syncDepth) {
        work();
        return;
      }
      syncDepth++;
      try {
        reconciler.flushSyncFromReconciler(work);
      } finally {
        syncDepth--;
      }
      flush();
    },
    flush,
    refreshNative() {
      assertMounted();
      state.commit();
    },
    async whenCommitted() {
      let pending: Promise<void>;
      do {
        pending = state.pending;
        await pending;
      } while (pending !== state.pending);
      if (state.error) throw state.error;
    },
    unmount() {
      if (!mounted) return;
      retiring = true;
      try {
        reconciler.updateContainerSync(null, container, null, null);
        flush();
      } finally {
        mounted = false;
        if (state.focusPresentation) clearTimeout(state.focusPresentation.timer);
        state.focusPresentation = undefined;
      }
    },
    get mounted() {
      return mounted;
    },
  };
  focusPresentations.set(root, (target, writes) => {
    if (
      !mounted ||
      retiring ||
      state.error ||
      committedGeneration !== state.generation ||
      state.focusPresentation
    )
      return false;
    const focus = elementsByHandle.get(target.handle);
    if (!focus?.ref || state.realized.get(focus) !== focus.ref) return false;
    const staged: Array<{ element: ElementNode; ref: SceneNodeRef; fields: SceneFields }> = [];
    for (const { node, fields } of writes) {
      const element = elementsByHandle.get(node.handle);
      if (!element?.ref || state.realized.get(element) !== element.ref) return false;
      staged.push({ element, ref: element.ref, fields });
    }
    const previews = new Set<ElementNode>();
    // Reconcile an unacknowledged request through the ordinary layout/field path.
    const timer = setTimeout(() => {
      if (mounted && state.focusPresentation?.timer === timer) state.commit();
    }, 250);
    state.focusPresentation = { nodes: previews, timer };
    port.batch(() => {
      for (const { element, ref, fields } of staged) {
        for (const [field, value] of Object.entries(fields)) {
          if (Object.is(element.appliedFields[field], value)) continue;
          previews.add(element);
          const applied = { ...element.appliedFields };
          try {
            port.set(ref, field, value);
            applied[field] = value;
          } catch (error) {
            // The port may have thrown after a native set. Require the next
            // commit to assert the canonical field again.
            delete applied[field];
            throw error;
          } finally {
            element.appliedFields = applied;
          }
        }
      }
      port.set(focus.ref!, "gainFocus", true);
    });
    return true;
  });
  opacityUpdates.set(root, (handle, value) => {
    if (!mounted || retiring || state.error || committedGeneration !== state.generation)
      return false;
    const node = elementsByHandle.get(handle);
    if (!node || !node.ref || state.realized.get(node) !== node.ref) return false;
    if (!Object.is(node.appliedFields.opacity, value)) {
      node.appliedAuthoredFields = undefined;
      port.batch(() => port.set(node.ref!, "opacity", value));
      // A later full commit must compare against the field actually written.
      node.appliedFields = { ...node.appliedFields, opacity: value };
    }
    return true;
  });
  return root;
}
