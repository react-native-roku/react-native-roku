import { createElement, Fragment } from "react";
import { createNativeRoot } from "react-native-roku";
import { TextRasterCache, type TextRasterTransport } from "react-native-roku/text-raster-cache";
import { Text, View } from "react-native";
import { RecordingSceneGraph } from "react-native-roku/testing";

/** Real cache ownership with explicit synthetic mask/write failure ports. */
export async function qualifyRasterFailureLifetimes() {
  const pending: { resolve(mask: Uint8Array): void; reject(error: unknown): void; size: number }[] =
      [],
    errors: string[] = [];
  let disposed = 0;
  const deleted: string[] = [];
  const transport: TextRasterTransport = {
    mask: (spec) =>
      new Promise((resolve, reject) =>
        pending.push({ resolve, reject, size: spec.width * spec.height }),
      ),
    write: async (name) => "fixture:/" + name,
    delete: async (uri) => {
      deleted.push(uri);
    },
    dispose: () => {
      disposed++;
    },
  };
  // Two 208x48 RGBA entries fit; a third must evict a released predecessor.
  const cache = new TextRasterCache(transport, 80_000),
    scene = new RecordingSceneGraph();
  const root = createNativeRoot(scene, {
    textRaster: cache,
    viewport: { width: 300, height: 100 },
    onError: (error) => errors.push(error.message),
    text: {
      prepare() {},
      metrics: () => ({ lineHeight: 20, width: (value: string) => value.length * 8 }),
    },
  });
  const demand = (condition: unknown, message: string) => {
    if (!condition) throw Error("Packed raster: " + message);
  };
  const text = (value: string) =>
    createElement(Text, { key: value, style: { width: 100, height: 20, letterSpacing: 1 } }, value);
  let heldAfterFailure = -1,
    liveAfterRecovery = -1;
  try {
    root.render(createElement(Fragment, {}, text("first"), text("second")));
    pending[0].resolve(new Uint8Array(pending[0].size));
    for (let index = 0; index < 12; index++) await Promise.resolve();
    demand(
      cache.diagnostics().leased === 2,
      "both preparing entries must own their work before failure",
    );
    pending[1].reject(Error("mask preparation failed"));
    let failure: unknown;
    try {
      await root.whenCommitted();
    } catch (error) {
      failure = error;
    }
    demand(
      failure instanceof Error && failure.message === "mask preparation failed",
      "the original preparation failure must remain observable",
    );
    heldAfterFailure = cache.diagnostics().leased;
    demand(
      heldAfterFailure === 0 && scene.nodes.size === 1,
      "failed preparation must release sibling cache leases without publication",
    );
    let latchedFailure: unknown;
    try {
      root.render(createElement(Fragment, {}, text("recovered"), text("other")));
    } catch (error) {
      latchedFailure = error;
    }
    demand(
      latchedFailure === failure,
      "the next synchronous flush must preserve the latched original error while recovery prepares",
    );
    pending[2].resolve(new Uint8Array(pending[2].size));
    pending[3].resolve(new Uint8Array(pending[3].size));
    await root.whenCommitted();
    liveAfterRecovery = cache.diagnostics().leased;
    demand(
      liveAfterRecovery === 2 && errors.length === 1 && deleted.length === 1,
      "a new generation must recover with its own retained raster",
    );
  } finally {
    root.unmount();
  }
  demand(
    disposed === 1 &&
      cache.diagnostics().entries === 0 &&
      scene.nodes.size === 1 &&
      scene.listenerCount === 0,
    "cache, transport and scene must retire completely",
  );
  const lateFailures = await qualifyLatePreparationRejections();
  return {
    originalFailure: true,
    heldAfterFailure,
    liveAfterRecovery,
    evictions: deleted.length,
    lateFailures,
    cleanup: true,
    scope:
      "Actual bounded cache and React owner, synthetic native mask/write transport; no firmware raster claim",
  };
}

async function qualifyLatePreparationRejections() {
  const outcomes = [];
  for (const kind of ["font", "raster"]) {
    const scene = new RecordingSceneGraph(),
      errors: string[] = [];
    let reject!: (error: unknown) => void;
    const pending = new Promise<never>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    const root = createNativeRoot(scene, {
      viewport: { width: 300, height: 100 },
      onError: (error) => errors.push(error.message),
      text: {
        prepare: (style) => {
          if (kind !== "font") return;
          if (style.fontSize === 20) return pending;
          throw Error("later synchronous font failure");
        },
        metrics: () => ({ lineHeight: 20, width: () => 8 }),
      },
      textRaster: { acquire: () => pending, dispose() {} },
    });
    let original: unknown;
    try {
      const first = createElement(
        Text,
        {
          style: { fontSize: 20, width: 100, height: 20, letterSpacing: kind === "raster" ? 1 : 0 },
        },
        "first",
      );
      root.render(
        createElement(
          Fragment,
          {},
          first,
          kind === "font"
            ? createElement(Text, { style: { fontSize: 30 } }, "second")
            : createElement(
                Fragment,
                {},
                createElement(View, { nativeID: "duplicate" }),
                createElement(View, { nativeID: "duplicate" }),
              ),
        ),
      );
      try {
        await root.whenCommitted();
      } catch (error) {
        original = error;
      }
      if (!(original instanceof Error))
        throw Error("Packed late preparation must fail synchronously");
      reject(Error("retired " + kind + " failed late"));
      // A turn boundary makes an unobserved rejection fail the independent Node consumer.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (errors.length !== 1) throw Error("A late preparation replaced its original failure");
    } finally {
      try {
        root.unmount();
      } catch (error) {
        if (error !== original) throw error;
      }
    }
    if (scene.nodes.size !== 1 || scene.listenerCount !== 0)
      throw Error("Late preparation cleanup failed");
    outcomes.push({ kind, originalPreserved: true, lateRejectionObserved: true, cleanup: true });
  }
  return outcomes;
}
