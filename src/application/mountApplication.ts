import { createNativeRoot } from "../react-native/createNativeRoot";
import { NativeInput } from "../react-native/NativeInput";
import { NativeSystemState } from "../react-native/NativeSystemState";
import { installNativeAnimationFrames } from "../services/nativeTimers";
import { installWebRuntime } from "../services/installWebRuntime";
import type { RokuHostContext, MountedRokuApplication } from "../host/host.types";
import { registeredApplication } from "./AppRegistry";
import type { ReactNode } from "react";
import type { NativeRootOptions } from "../react-native/nativeRoot.types";
import type { SceneRoot } from "../renderer/SceneRoot";
import type { SceneGraphPort } from "../scene/sceneGraph.types";
import type { WebTransport } from "../services/webRuntime";

export interface RokuApplicationContent {
  readonly element: ReactNode;
  dispose?(): void | Promise<void>;
}

export interface RokuApplicationContext extends Omit<NativeRootOptions, "input"> {
  readonly scene: SceneGraphPort;
  readonly webTransport?: WebTransport;
}

export interface RokuApplicationOptions<Content extends RokuApplicationContent> {
  /** Runs after host allocation, before lazy content creation. A throwing setup
   * owns rollback of resources it has not yet returned to this lifetime.
   * Return a synchronous retirement callback; resources needed by asynchronous
   * content disposal belong to the content's own disposer. */
  setup?(): void | (() => void);
  createContent(): Content;
  /** Host mode preserves the caller's fetch/global policy. */
  webRuntime?: "portable" | "host";
}

export interface MountedApplication<
  Content extends RokuApplicationContent,
> extends MountedRokuApplication {
  readonly content: Content;
  /** Diagnostics and host input transport; this lifetime owns its disposal. */
  readonly input: NativeInput;
  dispose(): Promise<void>;
}

/** One React root/input lifetime for registered and custom application entries.
 * The root owns text/raster providers; the SDK host may separately retry their
 * idempotent disposal. Timer compatibility is process-scoped and idempotent. */
export function mountApplication<Content extends RokuApplicationContent>(
  context: RokuApplicationContext,
  options: RokuApplicationOptions<Content>,
): MountedApplication<Content> {
  installNativeAnimationFrames();
  const input = new NativeInput();
  const system = context.system ?? new NativeSystemState({ appState: "active" });
  let root: SceneRoot | undefined, content: Content | undefined;
  let releaseWeb: (() => void) | undefined, releaseSetup: (() => void) | void;
  let retired = false,
    disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    // Publish the transaction before invoking consumer or React cleanup, both
    // of which may synchronously reenter disposal.
    let resolve!: () => void, reject!: (error: unknown) => void;
    disposal = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    retired = true;
    const failures: unknown[] = [];
    const attempt = (work: () => void) => {
      try {
        work();
      } catch (error) {
        failures.push(error);
      }
    };
    attempt(() => root?.unmount());
    attempt(() => input.dispose());
    // Subscriptions lose authority before consumer cleanup can yield or mount
    // another root. Global web leases remain available for that cleanup's IO.
    attempt(() => releaseSetup?.());
    let consumer: void | Promise<void>;
    attempt(() => {
      consumer = content?.dispose?.();
    });
    void Promise.resolve(consumer!)
      .catch((error) => {
        failures.push(error);
      })
      .then(() => {
        attempt(() => releaseWeb?.());
        if (failures.length) reject(failures[0]);
        else resolve();
      });
    return disposal;
  };
  try {
    root = createNativeRoot(context.scene, { ...context, system, input });
    if (options.webRuntime !== "host") releaseWeb = installWebRuntime(context.webTransport);
    releaseSetup = options.setup?.();
    content = options.createContent();
    root.render(content.element);
  } catch (error) {
    // Startup remains synchronous. Observe asynchronous cleanup without
    // replacing the allocation/setup/content/render error that the caller sees.
    void dispose().catch(() => undefined);
    throw error;
  }
  return {
    content,
    input,
    remote: (event) => !retired && input.dispatch(event),
    publishSystem: (snapshot) => {
      if (!retired) root!.runSync(() => system.publish(snapshot));
    },
    whenCommitted: () => (retired ? Promise.resolve() : root!.whenCommitted()),
    dispose,
  };
}

export function mountRegisteredApplication(
  context: RokuHostContext,
  options: {
    appKey: string;
    load(): void;
    initialProps?: Record<string, unknown>;
    webRuntime?: "portable" | "host";
  },
): MountedRokuApplication {
  return mountApplication(context, {
    webRuntime: options.webRuntime,
    createContent() {
      options.load();
      return { element: registeredApplication(options.appKey, options.initialProps) };
    },
  });
}
