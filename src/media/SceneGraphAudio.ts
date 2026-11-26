import { createElement, forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { useElement } from "../react-native/primitives";
import { useNativeHost } from "../react-native/nativeHostContext";
import type { SceneElementProps } from "../renderer/SceneRoot";
import { RokuHostError } from "../scene/sceneGraph.types";
import { createAudioSession, type AudioObservation } from "./audioSession";
export type { AudioObservation, AudioSnapshot, AudioState } from "./audioSession";

export interface SceneAudioSource {
  readonly uri: string;
  readonly format: "mp3" | "mp4" | "flac" | "hls" | "es.aac-adts";
  readonly headers?: Readonly<Record<string, string>>;
}
export interface SceneGraphAudioRef {
  seek(time: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
  setMuted(muted: boolean): void;
  getCurrentPosition(): Promise<number>;
}
export interface SceneGraphAudioProps {
  readonly source: SceneAudioSource;
  readonly paused?: boolean;
  readonly muted?: boolean;
  readonly repeat?: boolean;
  /** Milliseconds, matching SceneGraphVideo. Zero disables position notifications. */
  readonly progressUpdateInterval?: number;
  readonly onObservation?: (event: AudioObservation) => void;
  /** Host/command failures; native decoder errors arrive through onObservation. */
  readonly onError?: (error: Error) => void;
}

function validateSource(source: SceneAudioSource) {
  if (!/^(https?:\/\/|pkg:\/)[^\s]+$/.test(source.uri))
    throw new RokuHostError("C31_AUDIO_URI", "Audio requires an HTTP or packaged media URI");
  if (!["mp3", "mp4", "flac", "hls", "es.aac-adts"].includes(source.format))
    throw new RokuHostError(
      "C31_AUDIO_FORMAT",
      "Audio requires an explicit supported stream format",
    );
  return Object.entries(source.headers ?? {}).map(([key, value]) => {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) ||
      typeof value !== "string" ||
      /[\r\n]/.test(value)
    )
      throw new RokuHostError("C31_AUDIO_HEADER", "Invalid audio request header");
    return `${key}: ${value}`;
  });
}

const MountedSceneGraphAudio = forwardRef<SceneGraphAudioRef, SceneGraphAudioProps>(
  (props, ref) => {
    const host = useNativeHost(),
      element = useElement({}, null);
    const latest = useRef(props);
    latest.current = props;
    const session = useMemo(
      () => createAudioSession((event) => latest.current.onObservation?.(event)),
      [],
    );
    const alive = useRef(false),
      generation = useRef(0);
    const command = (fields: Readonly<Record<string, string | number | boolean>>) => {
      const owner = generation.current;
      if (alive.current && host.active && host.placement(element.id)?.handle.nativeRef) {
        host.audioCommand(element.id, fields);
        return;
      }
      void host
        .whenCommitted()
        .then(() => {
          if (alive.current && host.active && owner === generation.current)
            host.audioCommand(element.id, fields);
        })
        .catch((error) => {
          if (alive.current && owner === generation.current)
            latest.current.onError?.(error instanceof Error ? error : new Error(String(error)));
        });
    };
    useImperativeHandle(ref, () => ({
      seek(time) {
        session.seek(time);
        command({ seek: time });
      },
      pause() {
        command({ autoplayAfterSeek: false, control: "pause" });
      },
      resume() {
        command({
          autoplayAfterSeek: true,
          control: session.snapshot.state === "paused" ? "resume" : "play",
        });
      },
      stop() {
        command({ autoplayAfterSeek: false, control: "stop" });
      },
      setMuted(mute) {
        command({ mute });
      },
      getCurrentPosition: () => session.position(),
    }));
    useEffect(() => {
      alive.current = true;
      session.activate();
      return () => {
        alive.current = false;
        generation.current++;
        session.retire();
      };
    }, [session]);
    useEffect(() => {
      command({
        autoplayAfterSeek: !props.paused,
        control: props.paused
          ? session.snapshot.state === "none"
            ? "prebuffer"
            : "pause"
          : session.snapshot.state === "paused"
            ? "resume"
            : "play",
      });
    }, [props.paused]);
    const headers = validateSource(props.source);
    const interval = props.progressUpdateInterval ?? 250;
    if (!Number.isFinite(interval) || interval < 0)
      throw new RokuHostError(
        "C31_AUDIO_INTERVAL",
        "Audio notification interval must be finite and nonnegative",
      );
    return createElement(
      "audio",
      {
        fields: {
          ...element.fields,
          mute: props.muted ?? false,
          loop: props.repeat ?? false,
          notificationInterval: interval / 1000,
        },
        layout: { ...element.layout, resource: true },
        events: Object.fromEntries(
          ["state", "duration", "position", "audioFormat", "errorCode", "errorMsg"].map((field) => [
            field,
            (value: unknown) => session.observe(field, value),
          ]),
        ),
      } satisfies SceneElementProps,
      createElement("contentNode", {
        layout: { resource: true },
        fields: { url: props.source.uri, streamFormat: props.source.format, httpHeaders: headers },
      }),
    );
  },
);

/** Nonvisual resource. Source replacement retires the old decoder and its listeners. */
export const SceneGraphAudio = forwardRef<SceneGraphAudioRef, SceneGraphAudioProps>((props, ref) =>
  createElement(MountedSceneGraphAudio, { ...props, ref, key: JSON.stringify(props.source) }),
);
SceneGraphAudio.displayName = "RokuSceneGraphAudio";
