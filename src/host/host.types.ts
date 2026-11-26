import type { NativeRootOptions } from "../react-native/nativeRoot.types";
import type { SceneGraphPort } from "../scene/sceneGraph.types";
import type { TextMetricProvider } from "../layout/textLayout";
import type { TextRasterProvider } from "../graphics/textRaster.types";
import type { NativeSystemState, SystemSnapshot } from "../react-native/NativeSystemState";
import type { NativeRemoteEvent } from "../react-native/NativeInput";
import type { FontResourcesOptions } from "../layout/FontResources";
import type { WebTransport } from "../services/webRuntime";
export interface RokuDeviceSnapshot {
  readonly model: string;
  readonly osVersion: {
    readonly major: string;
    readonly minor: string;
    readonly revision: string;
    readonly build: string;
  };
  readonly graphicsPlatform: string;
}
export type RokuHostPhase = "startup" | "device-facts" | "memory" | "dispose";
export interface MountedRokuApplication {
  remote(event: NativeRemoteEvent): boolean;
  publishSystem(snapshot: Partial<SystemSnapshot>): void;
  whenCommitted(): Promise<void>;
  dispose(): void | Promise<void>;
}
export interface RokuHostContext extends NativeRootOptions {
  readonly scene: SceneGraphPort;
  readonly system: NativeSystemState;
  readonly text: TextMetricProvider;
  readonly textRaster: TextRasterProvider;
  readonly webTransport: WebTransport;
  readonly requestExit: () => void;
}
export interface RokuMemorySnapshot {
  readonly availableKb: unknown;
  readonly usagePercent: unknown;
  readonly limits: unknown;
  readonly hermesHeap: unknown;
}
export interface RokuHostOptions {
  readonly components: {
    readonly AppControl: string;
    readonly TextRaster: string;
    readonly TextRasterTask: string;
    readonly DeviceFacts: string;
    readonly DeviceFactsTask: string;
  };
  readonly fonts: FontResourcesOptions;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly storageNamespace?: string;
  readonly svgAtlas?: NativeRootOptions["svgAtlas"];
  readonly cornerMasks?: NonNullable<NativeRootOptions["graphics"]>["cornerMasks"];
  mount(context: RokuHostContext): MountedRokuApplication;
  onReady?(info: { readonly device: RokuDeviceSnapshot | null }): void | Promise<void>;
  onMemorySnapshot?(snapshot: RokuMemorySnapshot): void;
  onError?(error: Error, phase: RokuHostPhase): void;
}
