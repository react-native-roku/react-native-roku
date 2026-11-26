import type { IncomingMessage, ServerResponse } from "node:http";
export interface DevState {
  state: string;
  generation: number;
  error: string | null;
  sessionId: string;
  refresh?: import("./metroRefresh.mjs").RokuRefreshPlan;
  metrics: {
    builds: number;
    failures: number;
    lastBuildMs: number | null;
    lastEditToReadyMs: number | null;
    recentBuildMs: number[];
  };
}
export declare function createRokuDevServer(options: {
  build(context: {
    generation: number;
  }): Promise<
    string | { directory: string; refresh?: import("./metroRefresh.mjs").RokuRefreshPlan }
  >;
  watchPaths?: string[];
  port?: number;
  handleRequest?: (request: IncomingMessage, response: ServerResponse) => boolean;
  debounceMs?: number;
  onBuild?: (state: DevState) => void;
}): Promise<{
  url: string;
  snapshot(): DevState;
  invalidate(): void;
  rebuild(): Promise<void> | null;
  idle(): Promise<void>;
  close(): Promise<void>;
}>;
