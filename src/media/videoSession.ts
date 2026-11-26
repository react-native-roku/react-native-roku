import { RokuHostError } from "../scene/sceneGraph.types";
import {
  nativeErrorCode,
  nativeVideoErrorInfo,
  type NativeVideoErrorDetails,
} from "./videoErrorDetails";

export type VideoState =
  "none" | "buffering" | "playing" | "paused" | "stopped" | "finished" | "error";
export interface VideoSnapshot {
  readonly state: VideoState;
  readonly position?: number;
  readonly duration?: number;
  readonly renderedPosition?: number;
  readonly error?: NativeVideoErrorDetails;
}
export interface VideoObservation {
  readonly kind: "state" | "progress" | "duration" | "frame" | "seek" | "error" | "error-details";
  readonly snapshot: VideoSnapshot;
  readonly seekTime?: number;
}

/** One mounted content generation. Only native observations publish truth. */
export function createVideoSession(notify: (event: VideoObservation) => void) {
  let active = true;
  let snapshot: VideoSnapshot = { state: "none" };
  let seekTarget: number | undefined;
  let frameSeen = false;
  let error: NativeVideoErrorDetails | undefined;
  const publish = (kind: VideoObservation["kind"], extra = {}) => {
    if (active) notify({ kind, snapshot, ...extra });
  };
  const setErrorDetails = (next: NativeVideoErrorDetails | undefined) => {
    if (JSON.stringify(next) === JSON.stringify(error)) return;
    error = next && Object.freeze({ ...next });
    if (snapshot.state !== "error") return;
    const { error: _previous, ...base } = snapshot;
    snapshot = error ? { ...base, error } : base;
    publish("error-details");
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
      if (!active) throw new RokuHostError("C30_VIDEO_RETIRED", "The media session is retired");
      if (!finite(time))
        throw new RokuHostError(
          "C30_VIDEO_SEEK",
          "Seek targets must be finite nonnegative seconds",
        );
      seekTarget = time;
    },
    observe(field: string, value: unknown) {
      if (!active) return;
      if (field === "errorCode") {
        if (!nativeErrorCode(value) || value === error?.nativeCode) return;
        const { nativeCode: _previous, ...other } = error ?? {};
        setErrorDetails(
          value !== 0
            ? { ...other, nativeCode: value }
            : Object.keys(other).length
              ? other
              : undefined,
        );
        return;
      }
      if (field === "errorInfo") {
        const info = nativeVideoErrorInfo(value);
        if (info)
          setErrorDetails({
            ...(error?.nativeCode === undefined ? {} : { nativeCode: error.nativeCode }),
            ...info,
          });
        return;
      }
      if (
        field === "state" &&
        ["none", "buffering", "playing", "paused", "stopped", "finished", "error"].includes(
          String(value),
        )
      ) {
        if (value === "error" && snapshot.state === "error") return;
        const { error: _previous, ...base } = snapshot;
        if (snapshot.state === "error" && value !== "error") error = undefined;
        snapshot = {
          ...base,
          state: value as VideoState,
          ...(value === "error" && error ? { error } : {}),
        };
        publish(value === "error" ? "error" : "state");
      } else if (field === "position" && finite(value)) {
        snapshot = { ...snapshot, position: value };
        publish("progress");
      } else if (field === "duration" && finite(value)) {
        snapshot = { ...snapshot, duration: value };
        publish("duration");
      } else if (field === "positionInfo" && value && typeof value === "object") {
        const sample = value as { epoch?: unknown; video?: unknown };
        // UTC/live clocks need a source-time mapping. They are never confused
        // with elapsed VOD seconds or used to settle a VOD seek.
        if (sample.epoch !== 0 || !finite(sample.video)) return;
        snapshot = {
          ...snapshot,
          position: sample.video,
          renderedPosition: sample.video,
        };
        if (!frameSeen) {
          frameSeen = true;
          publish("frame");
        }
        if (seekTarget !== undefined && Math.abs(sample.video - seekTarget) <= 0.5) {
          const target = seekTarget;
          seekTarget = undefined;
          publish("seek", { seekTime: target });
        }
      }
    },
    position(): Promise<number> {
      return active && snapshot.position !== undefined
        ? Promise.resolve(snapshot.position)
        : Promise.reject(
            new RokuHostError("C30_VIDEO_POSITION", "No current native position has been observed"),
          );
    },
    retire() {
      active = false;
      seekTarget = undefined;
    },
  };
}
