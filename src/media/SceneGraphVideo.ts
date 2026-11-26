import { createElement, forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import type { NativeStyle } from "../react-native/styleSheet";
import { useElement } from "../react-native/primitives";
import { useNativeHost } from "../react-native/nativeHostContext";
import type { SceneElementProps } from "../renderer/SceneRoot";
import { RokuHostError } from "../scene/sceneGraph.types";
import { createVideoSession, type VideoObservation } from "./videoSession";

export interface SceneVideoSource {
  readonly uri: string;
  readonly format: "hls" | "dash" | "mp4" | "mkv" | "ism";
  readonly headers?: Readonly<Record<string, string>>;
  readonly startPosition?: number;
}
export interface SceneGraphVideoRef {
  seek(time: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
  setMuted(muted: boolean): void;
  getCurrentPosition(): Promise<number>;
}
export interface SceneGraphVideoProps {
  readonly source: SceneVideoSource;
  readonly style?: NativeStyle;
  readonly paused?: boolean;
  readonly muted?: boolean;
  readonly repeat?: boolean;
  readonly progressUpdateInterval?: number;
  readonly audioTrack?: string;
  readonly onObservation?: (event: VideoObservation) => void;
  readonly onAudioTracks?: (tracks: unknown) => void;
  readonly onCurrentAudioTrack?: (id: unknown) => void;
  readonly onError?: (error: Error) => void;
}

const MountedSceneGraphVideo = forwardRef<SceneGraphVideoRef, SceneGraphVideoProps>(
  (props, ref) => {
    const host = useNativeHost(),
      element = useElement({ style: props.style }, null);
    const latest = useRef(props);
    latest.current = props;
    const session = useMemo(
      () => createVideoSession((event) => latest.current.onObservation?.(event)),
      [],
    );
    const alive = useRef(false);
    const generation = useRef(0);
    const command = (fields: Readonly<Record<string, string | number | boolean>>) => {
      const owner = generation.current;
      // Retirement must reach the native transaction before the OS freezes JS.
      // Only pre-mount commands need to wait for allocation.
      if (alive.current && host.active && host.placement(element.id)?.handle.nativeRef) {
        host.videoCommand(element.id, fields);
        return;
      }
      void host
        .whenCommitted()
        .then(() => {
          if (alive.current && host.active && owner === generation.current)
            host.videoCommand(element.id, fields);
        })
        .catch((error) => {
          if (alive.current)
            latest.current.onError?.(error instanceof Error ? error : new Error(String(error)));
        });
    };
    useImperativeHandle(ref, () => ({
      seek(time) {
        session.seek(time);
        command({ seek: time });
      },
      pause() {
        command({ control: "pause" });
      },
      resume() {
        command({
          control: session.snapshot.state === "paused" ? "resume" : "play",
        });
      },
      stop() {
        command({ control: "stop" });
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
        control: props.paused
          ? session.snapshot.state === "none"
            ? "prebuffer"
            : "pause"
          : session.snapshot.state === "paused"
            ? "resume"
            : "play",
      });
    }, [props.paused]);
    const source = props.source;
    if (!/^(https?|pkg):\//.test(source.uri))
      throw new RokuHostError("C30_VIDEO_URI", "Video requires an HTTP or packaged media URI");
    if (
      source.startPosition !== undefined &&
      (!Number.isFinite(source.startPosition) || source.startPosition < 0)
    )
      throw new RokuHostError("C30_VIDEO_START", "Invalid source start position");
    const headers = Object.entries(source.headers ?? {}).map(([key, value]) => {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n]/.test(value))
        throw new RokuHostError("C30_VIDEO_HEADER", "Invalid media request header");
      return `${key}: ${value}`;
    });
    return createElement(
      "video",
      {
        fields: {
          ...element.fields,
          enableUI: false,
          enableTrickPlay: false,
          mute: props.muted ?? false,
          loop: props.repeat ?? false,
          suppressCaptions: true,
          subtitleTrack: "",
          notificationInterval: Math.max(0.1, (props.progressUpdateInterval ?? 250) / 1000),
          ...(props.audioTrack === undefined ? {} : { audioTrack: props.audioTrack }),
        },
        layout: element.layout,
        events: {
          state: (value) => session.observe("state", value),
          duration: (value) => session.observe("duration", value),
          position: (value) => session.observe("position", value),
          positionInfo: (value) => session.observe("positionInfo", value),
          errorCode: (value) => session.observe("errorCode", value),
          errorInfo: (value) => session.observe("errorInfo", value),
          availableAudioTracks: (value) => latest.current.onAudioTracks?.(value),
          currentAudioTrack: (value) => latest.current.onCurrentAudioTrack?.(value),
        },
      } satisfies SceneElementProps,
      createElement("contentNode", {
        layout: { resource: true },
        fields: {
          url: source.uri,
          streamFormat: source.format,
          httpHeaders: headers,
          ...(source.startPosition === undefined ? {} : { playStart: source.startPosition }),
        },
      }),
    );
  },
);
export const SceneGraphVideo = forwardRef<SceneGraphVideoRef, SceneGraphVideoProps>((props, ref) =>
  createElement(MountedSceneGraphVideo, {
    ...props,
    ref,
    key: JSON.stringify(props.source),
  }),
);
SceneGraphVideo.displayName = "RokuSceneGraphVideo";
