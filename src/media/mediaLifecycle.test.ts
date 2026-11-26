import { createElement as h, createRef, StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createNativeRoot } from "../react-native/createNativeRoot";
import { Text, View } from "../react-native/primitives";
import type { SceneFieldListener, SceneNodeRef } from "../scene/sceneGraph.types";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import { SceneGraphAudio } from "./SceneGraphAudio";
import { SceneGraphVideo, type SceneGraphVideoRef } from "./SceneGraphVideo";

/** Capture the actual subscribed native callback before retirement. Unlike
 * emit(oldNode), delivery here still calls callbacks already queued by native. */
class QueuedNativeObservations extends RecordingSceneGraph {
  readonly pending: Array<() => void> = [];
  private readonly observers = new Map<string, Set<SceneFieldListener>>();
  override subscribe(node: SceneNodeRef, field: string, callback: SceneFieldListener) {
    const key = `${node.id}:${field}`;
    const observers = this.observers.get(key) ?? new Set();
    observers.add(callback);
    this.observers.set(key, observers);
    const release = super.subscribe(node, field, callback);
    return () => {
      observers.delete(callback);
      if (!observers.size) this.observers.delete(key);
      release();
    };
  }
  enqueue(node: SceneNodeRef, field: string, value: unknown) {
    const callbacks = [...(this.observers.get(`${node.id}:${field}`) ?? [])];
    expect(callbacks.length, `A real ${field} observer must exist before enqueue`).toBeGreaterThan(
      0,
    );
    this.pending.push(() => callbacks.forEach((callback) => callback(value)));
  }
  deliver(reverse = false) {
    const batch = this.pending.splice(0);
    for (const callback of reverse ? batch.reverse() : batch) callback();
  }
  get queuedObserverCount() {
    return [...this.observers.values()].reduce((total, callbacks) => total + callbacks.size, 0);
  }
}

const metrics = () => ({ lineHeight: 20, width: (value: string) => value.length * 7 });
const mediaKinds = ["video", "audio"] as const;

describe("bounded native lifecycle replay (synthetic observations, no decoding claim)", () => {
  it.each(mediaKinds)(
    "replays four queued-event schedules across 48 %s title lifetimes",
    async (kind) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const scene = new QueuedNativeObservations();
      const ref = createRef<SceneGraphVideoRef>();
      const events: Array<{ title: string; kind: string; position?: number }> = [];
      const errors: Error[] = [];
      const root = createNativeRoot(scene, {
        viewport: { width: 640, height: 360 },
        strictMode: true,
        text: { prepare() {}, metrics },
      });
      const render = (title: string | null) => {
        const common = {
          ref,
          paused: false,
          onError: (error: Error) => errors.push(error),
          onObservation: (event: { kind: string; snapshot: { position?: number } }) =>
            events.push({ title: title!, kind: event.kind, position: event.snapshot.position }),
        };
        root.render(
          h(
            StrictMode,
            null,
            title === null
              ? null
              : h(
                  View,
                  { key: title },
                  kind === "video"
                    ? h(SceneGraphVideo, {
                        ...common,
                        source: { uri: `pkg:/videos/${title}.mp4`, format: "mp4" },
                      })
                    : h(SceneGraphAudio, {
                        ...common,
                        source: { uri: `pkg:/audio/${title}.mp3`, format: "mp3" },
                      }),
                ),
          ),
        );
      };
      const settle = async () => {
        await root.whenCommitted();
        await vi.runOnlyPendingTimersAsync();
        await root.whenCommitted();
      };
      try {
        for (let schedule = 0; schedule < 4; schedule++) {
          for (let cycle = 0; cycle < 12; cycle++) {
            const title = `${schedule}-${cycle}`;
            render(title);
            await settle();
            const node = [...scene.nodes.values()].find((node) => node.type === kind)!;
            const retained = ref.current!;
            const beforeCommands = events.length;
            retained.pause();
            retained.seek(30);
            retained.resume();
            expect(events).toHaveLength(beforeCommands);
            // Late native state/time are observations, never command acknowledgements.
            scene.enqueue(node, "state", "paused");
            scene.enqueue(node, "position", 3);
            scene.deliver(schedule % 2 === 1);
            expect(await retained.getCurrentPosition()).toBe(3);
            expect(node.fields.seek).toBe(30);
            retained.pause();
            retained.seek(40);
            if (kind === "audio") expect(node.fields.autoplayAfterSeek).toBe(false);
            const beforeStop = events.length;
            retained.stop();
            expect(events).toHaveLength(beforeStop);
            scene.enqueue(node, "position", 99);
            scene.enqueue(node, "state", "finished");
            if (kind === "video") scene.enqueue(node, "positionInfo", { epoch: 0, video: 40 });
            if (schedule === 0) scene.deliver();
            render(schedule === 3 ? `${title}-replacement` : null);
            await settle();
            const afterRetirement = events.length;
            // The old handle and queued native callbacks must never target its successor.
            retained.pause();
            retained.resume();
            retained.stop();
            retained.setMuted(true);
            expect(() => retained.seek(1)).toThrow("retired");
            await expect(retained.getCurrentPosition()).rejects.toThrow("No current native");
            scene.deliver(schedule === 2);
            await settle();
            expect(events).toHaveLength(afterRetirement);
            const stop = scene.operations.findIndex(
              (op) => op.node === node.id && op.field === "control" && op.value === "stop",
            );
            const removal = scene.operations.findIndex(
              (op, index) => index > stop && op.operation === "remove",
            );
            expect(stop).toBeGreaterThan(-1);
            expect(removal).toBeGreaterThan(stop);
            render(null);
            await settle();
            expect(scene.nodes.size).toBe(1);
            expect(scene.listenerCount).toBe(0);
            expect(scene.queuedObserverCount).toBe(0);
            expect(scene.pending).toHaveLength(0);
            expect(vi.getTimerCount()).toBe(0);
          }
        }
        expect(errors).toEqual([]);
      } finally {
        root.unmount();
        scene.deliver();
        await vi.runOnlyPendingTimersAsync();
        vi.useRealTimers();
      }
      expect(scene.nodes.size).toBe(1);
      expect(scene.listenerCount).toBe(0);
    },
  );

  it.each(mediaKinds)(
    "retires pending %s allocation/commands before asynchronous font completion",
    async (kind) => {
      const scene = new QueuedNativeObservations();
      const ref = createRef<SceneGraphVideoRef>();
      const events: unknown[] = [],
        errors: Error[] = [];
      let complete!: () => void;
      const font = new Promise<void>((resolve) => {
        complete = resolve;
      });
      const root = createNativeRoot(scene, {
        viewport: { width: 640, height: 360 },
        text: { prepare: () => font, metrics },
      });
      root.render(
        h(
          View,
          null,
          h(Text, null, "Pending native preparation"),
          kind === "video"
            ? h(SceneGraphVideo, {
                ref,
                source: { uri: "pkg:/videos/pending.mp4", format: "mp4" },
                onObservation: (event) => events.push(event),
                onError: (error) => errors.push(error),
              })
            : h(SceneGraphAudio, {
                ref,
                source: { uri: "pkg:/audio/pending.mp3", format: "mp3" },
                onObservation: (event) => events.push(event),
                onError: (error) => errors.push(error),
              }),
        ),
      );
      const stale = ref.current!;
      stale.pause();
      stale.seek(10);
      stale.resume();
      root.unmount();
      const count = scene.operations.length;
      complete();
      await root.whenCommitted();
      await Promise.resolve();
      expect(scene.operations).toHaveLength(count);
      expect(events).toEqual([]);
      expect(errors).toEqual([]);
      expect(scene.nodes.size).toBe(1);
      expect(scene.listenerCount).toBe(0);
    },
  );

  it.each(["details-first", "state-first", "interleaved"])(
    "publishes one recovery edge for %s native video errors",
    async (schedule) => {
      const scene = new QueuedNativeObservations();
      const events: string[] = [];
      const root = createNativeRoot(scene, {
        viewport: { width: 640, height: 360 },
        text: { prepare() {}, metrics },
      });
      try {
        root.render(
          h(SceneGraphVideo, {
            source: { uri: "pkg:/videos/error.mp4", format: "mp4" },
            onObservation: (event) => events.push(event.kind),
          }),
        );
        await root.whenCommitted();
        const node = [...scene.nodes.values()].find((node) => node.type === "video")!;
        const packets: Array<[string, unknown]> = [
          ["errorCode", -3],
          ["errorInfo", { category: "http", errcode: 503 }],
          ["state", "error"],
        ];
        if (schedule === "state-first") packets.reverse();
        if (schedule === "interleaved") packets.splice(1, 0, ["state", "error"]);
        for (const [field, value] of [...packets, ...packets]) scene.enqueue(node, field, value);
        scene.deliver();
        expect(events.filter((kind) => kind === "error")).toHaveLength(1);
        scene.enqueue(node, "state", "error");
        root.unmount();
        const before = events.length;
        scene.deliver();
        expect(events).toHaveLength(before);
      } finally {
        root.unmount();
      }
      expect(scene.nodes.size).toBe(1);
      expect(scene.listenerCount).toBe(0);
    },
  );
});
