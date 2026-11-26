export declare function parseActiveApp(xml: string): { id: string | null; name: string | null };
export declare function parseMediaPlayer(xml: string): {
  state: string | null;
  error: string | null;
  positionSeconds: number | null;
  durationSeconds: number | null;
};
export declare function parseDeviceFacts(xml: string): {
  model: string | null;
  modelName: string | null;
  firmware: string | null;
  developerEnabled: string | null;
};
export declare function createRokuDeviceClient(options: {
  host: string;
  ecpPort?: number;
  installerPort?: number;
  timeoutMs?: number;
}): {
  query(name: string): Promise<string>;
  keypress(key: string): Promise<void>;
  launch(): Promise<void>;
  terminate(): Promise<"terminated" | "not-running">;
  appInstalled(expectedName: string): Promise<boolean>;
  screenshot(password: string): Promise<{ data: Buffer; format: string }>;
};
export declare function captureRokuDiagnostics(
  host: string,
  options?: { port?: number; maxLines?: number; maxLineLength?: number },
): {
  ready: Promise<boolean>;
  clear(): void;
  snapshot(): { available: boolean; status: string; droppedLines: number; lines: string[] };
  close(): void;
};
export declare function parseRokuHostDiagnostics(lines: string[]): {
  identities: Array<{
    schema: "react-native-roku-build/v1";
    application: string;
    inputFingerprint?: string;
    runtimeSha256?: string;
    frontendGraphSha256?: string;
  }>;
  ready: Record<string, unknown>[];
  memory: Record<string, unknown>[];
  errors: string[];
};
