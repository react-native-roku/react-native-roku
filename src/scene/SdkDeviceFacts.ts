import type { DomNode, TmValue } from "@roku-sdk/interfaces";
import { tmTransaction } from "@roku-sdk/solid";
import { transactionManager } from "@roku-sdk/common/transaction";
import { RokuHostError } from "./sceneGraph.types";
import type { SystemSnapshot } from "../react-native/NativeSystemState";

/** Bounded raw DeviceInfo RPC. Codec policy lives in shared playback code. */
export class SdkDeviceFacts {
  private sequence = 0;
  private disposed = false;
  private tail = Promise.resolve();
  private current?: {
    id: number;
    resolve(value: unknown): void;
    reject(error: unknown): void;
    timer: ReturnType<typeof setTimeout>;
  };
  private readonly listeners = new Map<
    string,
    Set<(event: Readonly<Record<string, unknown>>) => void>
  >();
  private readonly reply = (value: unknown) => {
    let packet: { id?: number; facts?: unknown; error?: string };
    try {
      packet = JSON.parse(String(value));
    } catch {
      return;
    }
    if (!this.current || packet.id !== this.current.id) return;
    const pending = this.current;
    this.current = undefined;
    clearTimeout(pending.timer);
    if (packet.error) pending.reject(new RokuHostError("C31_DEVICE_FACTS", packet.error));
    else pending.resolve(packet.facts);
  };
  private readonly event = (value: unknown) => {
    if (this.disposed) return;
    let packet: {
      type?: string;
      snapshot?: Partial<SystemSnapshot>;
      routeEpoch?: number;
      level?: string;
    };
    try {
      packet = JSON.parse(String(value));
    } catch {
      return;
    }
    if (packet.type === "system" && packet.snapshot) this.onSystem(packet.snapshot);
    else if (packet.type === "capabilities")
      for (const listener of this.listeners.get("onAudioRouteChanged") ?? [])
        listener({ audioRouteEpoch: packet.routeEpoch });
    else if (packet.type === "memory") {
      const level = packet.level === "low" ? "warning" : packet.level;
      this.onMemory(level);
      for (const listener of this.listeners.get("onResourcePressure") ?? []) listener({ level });
    }
  };
  constructor(
    private readonly node: DomNode,
    private readonly onSystem: (snapshot: Partial<SystemSnapshot>) => void,
    private readonly onMemory: (level?: string) => void,
  ) {
    this.batch(() => {
      tmTransaction.setProperty(node, "onReply", this.reply as TmValue);
      tmTransaction.setProperty(node, "onEvent", this.event as TmValue);
    });
  }
  private batch(work: () => void) {
    transactionManager.startTransaction();
    work();
  }
  probe(request: Readonly<Record<string, unknown>>): Promise<unknown> {
    const payload = JSON.stringify(request);
    if (payload.length > 16_384)
      return Promise.reject(
        new RokuHostError("C31_DEVICE_FACTS", "Decoder request exceeds the bridge limit"),
      );
    const result = this.tail.then(
      () =>
        new Promise<unknown>((resolve, reject) => {
          if (this.disposed) {
            reject(new RokuHostError("C31_DEVICE_FACTS", "Device facts bridge retired"));
            return;
          }
          const id = ++this.sequence;
          const timer = setTimeout(() => {
            if (this.current?.id === id) {
              this.current = undefined;
              reject(new RokuHostError("C31_DEVICE_FACTS", "Device facts query timed out"));
            }
          }, 5000);
          this.current = { id, resolve, reject, timer };
          try {
            this.batch(() =>
              tmTransaction.setProperty(this.node, "request", JSON.stringify({ ...request, id })),
            );
          } catch (error) {
            clearTimeout(timer);
            this.current = undefined;
            reject(error);
          }
        }),
    );
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  addListener(
    name: string,
    listener: (event: Readonly<Record<string, unknown>>) => void,
  ): { remove(): void } {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
    return {
      remove: () => {
        listeners.delete(listener);
        if (!listeners.size && this.listeners.get(name) === listeners) this.listeners.delete(name);
      },
    };
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.current) {
      clearTimeout(this.current.timer);
      this.current.reject(new RokuHostError("C31_DEVICE_FACTS", "Device facts bridge retired"));
      this.current = undefined;
    }
    for (const listeners of this.listeners.values()) listeners.clear();
    this.listeners.clear();
    this.batch(() => {
      tmTransaction.setProperty(this.node, "request", JSON.stringify({ type: "dispose" }));
      tmTransaction.setProperty(
        this.node,
        "onReply",
        null as unknown as TmValue,
        this.reply as TmValue,
      );
      tmTransaction.setProperty(
        this.node,
        "onEvent",
        null as unknown as TmValue,
        this.event as TmValue,
      );
    });
  }
}
