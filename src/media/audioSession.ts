import { RokuHostError } from "../scene/sceneGraph.types";

export type AudioState =
  "none" | "buffering" | "playing" | "paused" | "stopped" | "finished" | "error";
export interface AudioSnapshot {
  readonly state: AudioState;
  readonly position?: number;
  readonly duration?: number;
  /** Decoder-reported format, independent of the requested stream container. */
  readonly format?: string;
  readonly errorCode?: number;
  readonly errorMessage?: string;
}
export interface AudioObservation {
  readonly kind: "state" | "progress" | "duration" | "format" | "error";
  readonly snapshot: AudioSnapshot;
}

/** One content lifetime. Commands never manufacture a position, duration or codec. */
export function createAudioSession(notify: (event: AudioObservation) => void) {
  let active = true;
  let snapshot: AudioSnapshot = Object.freeze({ state: "none" });
  const publish = (kind: AudioObservation["kind"], patch: Partial<AudioSnapshot>) => {
    snapshot = Object.freeze({ ...snapshot, ...patch });
    notify({ kind, snapshot });
  };
  const finite = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  return {
    activate() {
      active = true;
    },
    get snapshot() {
      return snapshot;
    },
    seek(time: number) {
      if (!active) throw new RokuHostError("C31_AUDIO_RETIRED", "The audio session is retired");
      if (!finite(time))
        throw new RokuHostError(
          "C31_AUDIO_SEEK",
          "Seek targets must be finite nonnegative seconds",
        );
    },
    observe(field: string, value: unknown) {
      if (!active) return;
      if (
        field === "state" &&
        typeof value === "string" &&
        ["none", "buffering", "playing", "paused", "stopped", "finished", "error"].includes(value)
      )
        publish(value === "error" ? "error" : "state", { state: value as AudioState });
      else if (field === "position" && finite(value)) publish("progress", { position: value });
      else if (field === "duration" && finite(value)) publish("duration", { duration: value });
      else if (
        field === "audioFormat" &&
        typeof value === "string" &&
        /^[a-z0-9_]{1,32}$/.test(value)
      )
        publish("format", { format: value });
      else if (
        field === "errorCode" &&
        typeof value === "number" &&
        Number.isInteger(value) &&
        value !== 0
      )
        publish("error", { errorCode: value });
      else if (field === "errorMsg" && typeof value === "string" && value.length)
        publish("error", { errorMessage: value.slice(0, 2048) });
    },
    position(): Promise<number> {
      return active && snapshot.position !== undefined
        ? Promise.resolve(snapshot.position)
        : Promise.reject(
            new RokuHostError(
              "C31_AUDIO_POSITION",
              "No current native audio position has been observed",
            ),
          );
    },
    retire() {
      active = false;
    },
  };
}
