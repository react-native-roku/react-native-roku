/** The device boundary. A host commit is distinct from observed device presentation. */
export interface SceneNodeRef {
  readonly id: number;
  readonly type: string;
}

export type SceneValue =
  | null
  | boolean
  | number
  | string
  | SceneNodeRef
  | readonly unknown[]
  | Readonly<Record<string, unknown>>;
export type SceneFields = Readonly<Record<string, SceneValue>>;
export type SceneFieldListener = (value: unknown) => void;

export interface SceneGraphPort {
  readonly root: SceneNodeRef;
  create(type: string): SceneNodeRef;
  set(node: SceneNodeRef, field: string, value: SceneValue): void;
  insert(parent: SceneNodeRef, child: SceneNodeRef, before?: SceneNodeRef): void;
  remove(parent: SceneNodeRef, child: SceneNodeRef): void;
  subscribe(node: SceneNodeRef, field: string, listener: SceneFieldListener): () => void;
  batch(work: () => void): void;
  /** Optional native readback after a focus event was missed. */
  sampleFocus?(nodes: readonly SceneNodeRef[], receive: (node: SceneNodeRef) => void): void;
}

export class RokuHostError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[Roku ${code}] ${message}`);
    this.name = "RokuHostError";
  }
}
