import type { DomNode, TmValue } from "@roku-sdk/interfaces";
import { tmTransaction } from "@roku-sdk/solid";
import { transactionManager } from "@roku-sdk/common/transaction";
import type { TextRasterTransport } from "../graphics/TextRasterCache";
import type { TextRasterSpec } from "../graphics/textRaster.types";
import { decodeBase64, encodeBase64 } from "../services/base64";
import { RokuHostError } from "./sceneGraph.types";
interface Reply {
  readonly id: number;
  readonly error?: string;
  readonly pixels?: string;
  readonly uri?: string;
}
/** Two-phase native font mask / portable JS paint pipeline. All payloads are mechanical graphics. */
export class SdkTextRasterTransport implements TextRasterTransport {
  private sequence = 0;
  private disposed = false;
  private disposing = false;
  private disposalSubmitted = false;
  private listenerDetached = false;
  private tail = Promise.resolve();
  private current?: {
    id: number;
    resolve(reply: Reply): void;
    reject(error: unknown): void;
    timer: ReturnType<typeof setTimeout>;
  };
  private readonly listener = (value: unknown) => {
    let reply: Reply;
    try {
      reply = JSON.parse(String(value)) as Reply;
    } catch {
      return;
    }
    const pending = this.current;
    if (!pending || reply.id !== pending.id) return;
    this.current = undefined;
    clearTimeout(pending.timer);
    if (reply.error) pending.reject(new RokuHostError("C04_NATIVE_RASTER", reply.error));
    else pending.resolve(reply);
  };
  constructor(
    private readonly node: DomNode,
    private readonly fonts: Readonly<Record<string, string>>,
    namespace: string,
  ) {
    this.fonts = Object.freeze({ ...fonts });
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(namespace))
      throw new RokuHostError("C04_RASTER_NAMESPACE", "Invalid temporary raster namespace");
    this.batch(() => {
      tmTransaction.setProperty(node, "namespace", namespace);
      tmTransaction.setProperty(node, "onReply", this.listener as TmValue);
    });
  }
  private batch(work: () => void): void {
    transactionManager.startTransaction();
    work();
  }
  private request(payload: Record<string, unknown>): Promise<Reply> {
    if (this.disposed)
      return Promise.reject(
        new RokuHostError("C04_RASTER_DISPOSED", "Native text raster transport retired"),
      );
    const result = this.tail.then(
      () =>
        new Promise<Reply>((resolve, reject) => {
          if (this.disposed) {
            reject(
              new RokuHostError("C04_RASTER_DISPOSED", "Native text raster transport retired"),
            );
            return;
          }
          const id = ++this.sequence;
          const timer = setTimeout(() => {
            if (this.current?.id !== id) return;
            this.current = undefined;
            reject(
              new RokuHostError("C04_RASTER_TIMEOUT", "Native text raster operation timed out"),
            );
          }, 20_000);
          this.current = { id, resolve, reject, timer };
          try {
            this.batch(() =>
              tmTransaction.setProperty(this.node, "request", JSON.stringify({ ...payload, id })),
            );
          } catch (error) {
            clearTimeout(timer);
            if (this.current?.id === id) this.current = undefined;
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
  async mask(spec: TextRasterSpec): Promise<Uint8Array> {
    const font = this.fonts[spec.fontFamily];
    if (!font)
      throw new RokuHostError("C04_FONT_ASSET", "No packaged font exists for the raster request");
    const reply = await this.request({
      type: "mask",
      width: spec.width,
      height: spec.height,
      font,
      size: spec.fontSize,
      lineHeight: spec.lineHeight,
      commands: spec.commands,
    });
    const rgba = decodeBase64(reply.pixels ?? "");
    if (rgba.length !== spec.width * spec.height * 4)
      throw new RokuHostError("C04_RASTER_PIXELS", "Native font mask has the wrong byte length");
    const alpha = new Uint8Array(spec.width * spec.height);
    for (let index = 0; index < alpha.length; index++) alpha[index] = rgba[index * 4 + 3];
    return alpha;
  }
  async write(name: string, bytes: Uint8Array): Promise<string> {
    if (!/^text-\d+\.png$/.test(name))
      throw new RokuHostError("C04_RASTER_PATH", "Invalid temporary raster name");
    const reply = await this.request({
      type: "write",
      name,
      data: encodeBase64(bytes),
    });
    if (!reply.uri?.startsWith("tmp:/react-native-roku-text-"))
      throw new RokuHostError(
        "C04_RASTER_PATH",
        "Native text raster returned an invalid temporary URI",
      );
    return reply.uri;
  }
  async delete(uri: string): Promise<void> {
    await this.request({ type: "delete", uri });
  }
  dispose(): void {
    if (this.disposing || (this.disposalSubmitted && this.listenerDetached)) return;
    this.disposed = true;
    this.disposing = true;
    const failures: unknown[] = [];
    try {
      if (this.current) {
        const pending = this.current;
        this.current = undefined;
        try {
          clearTimeout(pending.timer);
        } catch (error) {
          failures.push(error);
        }
        pending.reject(
          new RokuHostError("C04_RASTER_DISPOSED", "Native text raster transport retired"),
        );
      }
      try {
        this.batch(() => {
          if (!this.disposalSubmitted)
            try {
              tmTransaction.setProperty(
                this.node,
                "request",
                JSON.stringify({ type: "dispose", id: ++this.sequence }),
              );
              this.disposalSubmitted = true;
            } catch (error) {
              failures.push(error);
            }
          if (!this.listenerDetached)
            try {
              tmTransaction.setProperty(
                this.node,
                "onReply",
                null as unknown as TmValue,
                this.listener as TmValue,
              );
              this.listenerDetached = true;
            } catch (error) {
              failures.push(error);
            }
        });
      } catch (error) {
        failures.push(error);
      }
    } finally {
      this.disposing = false;
    }
    // Submission and observer detachment are separate owned mechanics. Retry
    // only a failed step; neither a failed step nor a late reply reopens input.
    if (failures.length) throw failures[0];
  }
}
