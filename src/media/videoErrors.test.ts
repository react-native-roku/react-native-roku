import { expect, it } from "vitest";
import { createVideoSession, type VideoObservation } from "./videoSession";

it("retains bounded native codes without turning diagnostics into a playback failure", () => {
  const events: VideoObservation[] = [],
    session = createVideoSession((event) => events.push(event));
  session.observe("errorCode", -3);
  session.observe("errorInfo", {
    category: "http",
    errcode: 503,
    drmerrcode: 0,
    ignored: 0,
    clipId: 2,
    source: "private-module",
    dbgmsg: "https://private.invalid/secret?token=credential",
    extra: "credential",
  });
  expect(events).toEqual([]);
  expect(session.snapshot.state).toBe("none");
  session.observe("state", "error");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    kind: "error",
    snapshot: {
      state: "error",
      error: {
        nativeCode: -3,
        internalCode: 503,
        category: "http",
        clipId: 2,
        ignored: false,
      },
    },
  });
  expect(JSON.stringify(events)).not.toMatch(/private|secret|credential|dbgmsg|source|extra/);
});

it("publishes late code changes as details without duplicating the failure/recovery edge", () => {
  const events: VideoObservation[] = [],
    session = createVideoSession((event) => events.push(event));
  session.observe("state", "error");
  session.observe("errorCode", -3);
  session.observe("errorCode", -3);
  session.observe("state", "error");
  expect(events.map((event) => event.kind)).toEqual(["error", "error-details"]);
  session.observe("errorInfo", {
    category: "drm",
    errcode: 7,
    drmerrcode: -8,
    ignored: 1,
    clipId: 0,
  });
  expect(events.at(-1)).toMatchObject({
    kind: "error-details",
    snapshot: {
      error: {
        nativeCode: -3,
        internalCode: 7,
        drmCode: -8,
        category: "drm",
        ignored: true,
        clipId: 0,
      },
    },
  });
  expect(events.filter((event) => event.kind === "error")).toHaveLength(1);
});

it("rejects malformed diagnostics and never retains arbitrary strings or unbounded values", () => {
  const events: VideoObservation[] = [],
    session = createVideoSession((event) => events.push(event));
  for (const value of [NaN, Infinity, 1.5, 2 ** 32, "-3", null, {}, []])
    session.observe("errorCode", value);
  for (const value of [
    null,
    [],
    "secret",
    { category: "secret", errcode: Infinity, drmerrcode: "credential", ignored: 4, clipId: -1 },
  ])
    session.observe("errorInfo", value);
  session.observe("errorMsg", "credential");
  session.observe("errorStr", "secret");
  session.observe("state", "error");
  expect(events).toEqual([{ kind: "error", snapshot: { state: "error" } }]);
  session.observe("errorCode", 0);
  expect(events).toHaveLength(1);
});

it("clears failure details on resumed playback and fences every retired content generation", () => {
  const events: VideoObservation[] = [],
    session = createVideoSession((event) => events.push(event));
  session.observe("errorCode", -3);
  session.observe("state", "error");
  session.observe("state", "buffering");
  session.observe("state", "playing");
  session.observe("state", "error");
  expect(events.at(-1)).toEqual({ kind: "error", snapshot: { state: "error" } });
  expect(events.filter((event) => event.kind === "error")).toHaveLength(2);
  session.retire();
  const count = events.length;
  session.observe("errorCode", -9);
  session.observe("errorInfo", { category: "http", errcode: 503 });
  session.observe("state", "error");
  expect(events).toHaveLength(count);
  expect(createVideoSession(() => {}).snapshot).toEqual({ state: "none" });
});
