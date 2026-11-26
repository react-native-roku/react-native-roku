export type RokuRefreshPlan =
  | { type: "reload"; reason: string; sessionId: string; generation: number }
  | {
      type: "refresh";
      sessionId: string;
      fromGeneration: number;
      generation: number;
      updateId: string;
      paths: string[];
      moduleIds: Array<number | string>;
      changed: string[];
    };
export interface RokuMetroRefreshGraph {
  sessionId: string;
  generation: number;
  runtimeSha256: string;
  bootstrapSha256: string;
  bindings: string[];
  maxModuleBytes: number;
  sourceMap?: { path: string; sha256: string; url: string };
  modules: Array<{
    id: string | number;
    source: string;
    safe: boolean;
    dependencies: Array<string | number>;
    code: string;
    span: { startLine: number; startColumn: number; endLine: number; endColumn: number };
    sha256: string;
  }>;
}
export interface RokuMetroRefreshSession {
  readonly id: string;
  readonly directory: string;
  createModuleIdFactory(
    original: () => (path: string) => number | string,
  ): () => (path: string) => number | string;
  classify(path: string, source: string | null): boolean;
  stage(options: {
    generation: number;
    graph: RokuMetroRefreshGraph;
    identity: string;
    outputDirectory: string;
  }): RokuRefreshPlan;
  plan(generation: number): RokuRefreshPlan | null;
  discard(generation: number): void;
  publish(generation: number): void;
  dispose(): void;
}
export interface RokuMetroRefreshContext {
  session: RokuMetroRefreshSession;
  generation: number;
}
export declare function createRokuMetroRefreshSession(options: {
  root?: string;
  directory: string;
  sourceRoots?: string[];
}): RokuMetroRefreshSession;
export declare function isRefreshSafeSource(path: string, contents: string): boolean;
export declare function writeRokuRefreshBootstrap(options: {
  root?: string;
  session: RokuMetroRefreshSession;
  generation: number;
  outfile: string;
}): string;
