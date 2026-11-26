import { expect, it, vi } from "vitest";
import { FontResources, type FontCancellation } from "./FontResources";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";

const metrics = { lineHeight: 20, width: () => 8 };
class FaultScene extends RecordingSceneGraph {
  setupFailure?: Error;
  insertFailure?: Error;
  insertAfterMutation = false;
  removeFailures = 0;
  onRemove?: () => void;
  readonly cleanupFailure = Error("Font removal transport failed");
  override insert(...args: Parameters<RecordingSceneGraph["insert"]>) {
    if (args[1].type === "font" && this.insertFailure) {
      const failure = this.insertFailure;
      this.insertFailure = undefined;
      if (this.insertAfterMutation) super.insert(...args);
      throw failure;
    }
    super.insert(...args);
  }
  override set(...args: Parameters<RecordingSceneGraph["set"]>) {
    if (args[0].type === "font" && args[1] === "size" && this.setupFailure) {
      const failure = this.setupFailure;
      this.setupFailure = undefined;
      throw failure;
    }
    super.set(...args);
  }
  override remove(...args: Parameters<RecordingSceneGraph["remove"]>) {
    const onRemove = this.onRemove;
    this.onRemove = undefined;
    onRemove?.();
    if (args[1].type === "font" && this.removeFailures > 0) {
      this.removeFailures--;
      throw this.cleanupFailure;
    }
    super.remove(...args);
  }
}
function fixture() {
  const scene = new FaultScene(),
    failure = Error("Font size transport failed"),
    ready = vi.fn(async () => {});
  scene.setupFailure = failure;
  const fonts = new FontResources(
    scene,
    { ready, metrics: () => metrics },
    {
      assets: { Body: "pkg:/fonts/body.ttf" },
      defaultFamily: "Body",
      maximumFonts: 1,
    },
  );
  return { scene, failure, ready, fonts };
}

it("releases a font whose native initialization throws before readiness starts", () => {
  const f = fixture();
  try {
    expect(() => f.fonts.prepare({ fontSize: 20 })).toThrow(f.failure);
    expect(f.scene.nodes.size).toBe(1);
    expect(f.ready).not.toHaveBeenCalled();
  } finally {
    f.fonts.dispose();
  }
});

it.each([false, true])(
  "reclaims a retained ref after insertion throws (mutationApplied=%s)",
  async (insertAfterMutation) => {
    const f = fixture();
    f.scene.setupFailure = undefined;
    f.scene.insertFailure = f.failure;
    f.scene.insertAfterMutation = insertAfterMutation;
    try {
      expect(() => f.fonts.prepare({ fontSize: 20 })).toThrow(f.failure);
      await expect(f.fonts.prepare({ fontSize: 20 })).rejects.toBe(f.failure);
      expect(f.scene.nodes.size).toBe(1);
      expect(f.ready).not.toHaveBeenCalled();
    } finally {
      f.fonts.dispose();
    }
  },
);

it("retains the original initialization rejection instead of a successful placeholder promise", async () => {
  const f = fixture();
  try {
    expect(() => f.fonts.prepare({ fontSize: 20 })).toThrow(f.failure);
    await expect(f.fonts.prepare({ fontSize: 20 })).rejects.toBe(f.failure);
    // Existing negative-cache budget policy remains explicit and unchanged.
    expect(() => f.fonts.prepare({ fontSize: 21 })).toThrow(/budget/);
  } finally {
    f.fonts.dispose();
  }
});

it("preserves a synchronous setup error when cleanup throws and retries cleanup on disposal", () => {
  const f = fixture();
  f.scene.removeFailures = 1;
  expect(() => f.fonts.prepare({ fontSize: 20 })).toThrow(f.failure);
  f.fonts.dispose();
  expect(f.scene.nodes.size).toBe(1);
});

it("preserves asynchronous readiness failure when cleanup throws and retains disposal authority", async () => {
  const scene = new FaultScene(),
    failure = Error("Font readiness failed");
  scene.removeFailures = 1;
  const fonts = new FontResources(
    scene,
    {
      ready: async () => {
        throw failure;
      },
      metrics: () => metrics,
    },
    {
      assets: { Body: "pkg:/fonts/body.ttf" },
      defaultFamily: "Body",
    },
  );
  await expect(fonts.prepare({ fontSize: 20 })).rejects.toBe(failure);
  fonts.dispose();
  expect(scene.nodes.size).toBe(1);
});

it.each([false, true])(
  "attempts every font cleanup and retains only failed disposal work (pending=%s)",
  async (pending) => {
    const scene = new FaultScene(),
      signals: FontCancellation[] = [];
    const fonts = new FontResources(
      scene,
      {
        ready: (_ref, signal) => {
          signals.push(signal);
          return pending ? new Promise<void>(() => {}) : Promise.resolve();
        },
        metrics: () => metrics,
      },
      { assets: { Body: "pkg:/fonts/body.ttf" }, defaultFamily: "Body" },
    );
    const preparations = [fonts.prepare({ fontSize: 20 }), fonts.prepare({ fontSize: 22 })];
    await Promise.resolve();
    if (!pending) await Promise.all(preparations);
    scene.removeFailures = 1;
    expect(() => fonts.dispose()).toThrow(scene.cleanupFailure);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(scene.nodes.size).toBe(2);
    if (pending)
      for (const preparation of preparations) await expect(preparation).rejects.toThrow(/disposed/);
    expect(() => fonts.prepare({ fontSize: 24 })).toThrow(/disposed/);
    fonts.dispose();
    expect(scene.nodes.size).toBe(1);
    expect(scene.operations.filter((operation) => operation.operation === "remove")).toHaveLength(
      2,
    );
  },
);

it("does not repeat an in-progress native removal when cleanup reenters disposal", async () => {
  const scene = new FaultScene();
  const fonts = new FontResources(
    scene,
    { ready: async () => {}, metrics: () => metrics },
    {
      assets: { Body: "pkg:/fonts/body.ttf" },
      defaultFamily: "Body",
    },
  );
  await fonts.prepare({ fontSize: 20 });
  scene.onRemove = () => fonts.dispose();
  expect(() => fonts.dispose()).not.toThrow();
  expect(scene.nodes.size).toBe(1);
  expect(scene.operations.filter((operation) => operation.operation === "remove")).toHaveLength(1);
});

it("does not start native readiness after immediate disposal retires a queued preparation", async () => {
  const scene = new FaultScene(),
    ready = vi.fn(async () => {});
  const fonts = new FontResources(
    scene,
    { ready, metrics: () => metrics },
    {
      assets: { Body: "pkg:/fonts/body.ttf" },
      defaultFamily: "Body",
    },
  );
  const preparation = fonts.prepare({ fontSize: 20 });
  fonts.dispose();
  await expect(preparation).rejects.toThrow(/disposed/);
  expect(ready).not.toHaveBeenCalled();
  expect(scene.nodes.size).toBe(1);
});

it("rejects preparation if metric acquisition reentrantly disposes its font owner", async () => {
  const scene = new FaultScene();
  const fonts = new FontResources(
    scene,
    {
      ready: async () => {},
      metrics: () => {
        fonts.dispose();
        return metrics;
      },
    },
    { assets: { Body: "pkg:/fonts/body.ttf" }, defaultFamily: "Body" },
  );
  await expect(fonts.prepare({ fontSize: 20 })).rejects.toThrow(/disposed/);
  expect(scene.nodes.size).toBe(1);
});
