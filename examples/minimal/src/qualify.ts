import { createElement, createRef, Fragment, useLayoutEffect } from "react";
import { createNativeRoot, NativeInput } from "react-native-roku";
import { RecordingSceneGraph } from "react-native-roku/testing";
import { App } from "./App";
import {
  SceneGraphAudio,
  SceneGraphVideo,
  type SceneGraphAudioRef,
  type AudioObservation,
} from "react-native-roku/media";
import { createPortableFetch, type WebRequest } from "react-native-roku/web";
import {
  Text,
  View,
  ScrollView,
  Pressable,
  TextInput,
  AccessibilityInfo,
  findNodeHandle,
} from "react-native";
import { NativeSystemState } from "react-native-roku/system";
import { qualifyKeyboard } from "./keyboard";
import { qualifyCollections } from "./collections";
import { qualifyAnimations } from "./animations";
import { qualifyAccessibilityRelationships } from "./accessibilityRelationships";
import { qualifyColumnCollections } from "./columnCollections";
import { qualifyHorizontalCollections } from "./horizontalCollections";
import { qualifySeparatorCollections } from "./separatorCollections";
import { qualifyModalLifetimes } from "./modalLifetimes";
import { qualifyImageLifetimes } from "./imageLifetimes";
import { qualifyRasterFailureLifetimes } from "./rasterFailureLifetimes";
import { qualifyAccessibilityDescriptions } from "./accessibilityDescriptions";
import { qualifyAccessibilityRetirement } from "./accessibilityRetirement";
import { qualifyCollectionBoundaryStyles } from "./collectionBoundaryStyles";
import { qualifyFocusObservationLifetimes } from "./focusObservationLifetimes";
import { qualifyCollectionGeometryLifetimes } from "./collectionGeometryLifetimes";
import { qualifyCollectionViewability } from "./collectionViewability";
import { qualifyCleanupLifetimes } from "./cleanupLifetimes";
import { qualifyRasterReservations } from "./rasterReservations";
import { qualifyBackLifetimes } from "./backLifetimes";
import { qualifyApplicationOwnership } from "./applicationOwnership";
export async function qualify() {
  const scene = new RecordingSceneGraph(),
    input = new NativeInput();
  const announcements: string[] = [];
  const system = new NativeSystemState({ screenReader: true }, (message) => {
    announcements.push(message);
  });
  const root = createNativeRoot(scene, {
    input,
    strictMode: true,
    system,
    viewport: { width: 640, height: 360 },
    text: {
      async prepare() {},
      metrics: () => ({
        lineHeight: 24,
        width: (value: string) => value.length * 10,
      }),
      fontAsset: (style) => `fixture:/${String(style.fontFamily)}.ttf`,
    },
  });
  let effectSetups = 0,
    effectCleanups = 0;
  function ReplayProbe() {
    useLayoutEffect(() => {
      effectSetups++;
      return () => {
        effectCleanups++;
      };
    }, []);
    return null;
  }
  root.render(createElement(Fragment, {}, createElement(ReplayProbe), createElement(App)));
  await root.whenCommitted();
  if (effectSetups < 2 || effectCleanups !== effectSetups - 1)
    throw Error("Packed consumer did not execute root StrictMode effect replay");
  const button = [...scene.nodes.values()].find((node) => node.fields.id === "increment");
  if (!button) throw Error("Consumer Pressable did not render");
  scene.emit(button, "focusedChild", "increment");
  input.dispatch({ key: "select", phase: "down" });
  input.dispatch({ key: "select", phase: "up" });
  await root.whenCommitted();
  const texts = [...scene.nodes.values()].map((node) => node.fields.text).filter(Boolean);
  if (!texts.some((text) => String(text).includes("Count 1")))
    throw Error("Consumer React state did not update: " + JSON.stringify(texts));
  root.render(
    createElement(
      Text,
      {
        style: { width: 80, fontFamily: "FixtureNormal", fontSize: 20, lineHeight: 24 },
      },
      "Open ",
      createElement(Text, { style: { fontFamily: "FixtureBold", color: "red" } }, "Forest"),
      " now",
    ),
  );
  await root.whenCommitted();
  const paragraph = scene.root.children[0];
  const paragraphLines = paragraph.children.map((node) =>
    String(node.fields.text).replace(/<[^>]*>/g, ""),
  );
  if (
    paragraph.type !== "group" ||
    JSON.stringify(paragraphLines) !== JSON.stringify(["Open", "Forest", "now"])
  )
    throw Error("Consumer mixed paragraph did not wrap through native styled lines");
  const thirdTranslation = paragraph.children[2].fields.translation;
  if (
    !paragraph.children.every((node) => node.type === "multiStyleLabel") ||
    !Array.isArray(thirdTranslation) ||
    thirdTranslation[1] !== 48
  )
    throw Error("Consumer mixed paragraph lost native line geometry");
  const scroll = createRef<import("react").ElementRef<typeof ScrollView>>(),
    focusTarget = createRef<import("react-native-roku/react-native").NativeViewHandle>();
  let observedFocus = 0;
  root.render(
    createElement(
      ScrollView,
      {
        ref: scroll,
        style: { width: 200, height: 100, flexGrow: 0, flexShrink: 0 },
        onFocus(event) {
          if (event.target !== focusTarget.current || event.currentTarget !== scroll.current)
            throw Error("Consumer focus lost its target or scroll ancestor identity");
          observedFocus++;
          event.target.measureLayout(event.currentTarget, (_x, y) =>
            scroll.current!.scrollTo({ y: y - 20, animated: false }),
          );
        },
      },
      createElement(
        View,
        { style: { height: 400 } },
        createElement(Pressable, {
          ref: focusTarget,
          nativeID: "scroll-target",
          style: { marginTop: 220, height: 40 },
        }),
      ),
    ),
  );
  await root.whenCommitted();
  let viewportHeight = -1;
  scroll.current!.measureInWindow((_x, _y, _width, height) => {
    viewportHeight = height;
  });
  if (viewportHeight !== 100)
    throw Error("Consumer scroll viewport did not retain its explicit bound");
  focusTarget.current!.focus();
  AccessibilityInfo.setAccessibilityFocus(findNodeHandle(focusTarget.current)!);
  const otherScene = new RecordingSceneGraph(),
    otherInput = new NativeInput();
  const otherRoot = createNativeRoot(otherScene, {
    input: otherInput,
    system,
    viewport: { width: 640, height: 360 },
    text: {
      prepare() {},
      metrics: () => ({ lineHeight: 24, width: (value: string) => value.length * 10 }),
    },
  });
  try {
    otherRoot.render(createElement(View));
    await otherRoot.whenCommitted();
    const requests = scene.operations.length,
      otherRequests = otherScene.operations.length;
    AccessibilityInfo.setAccessibilityFocus(findNodeHandle(focusTarget.current)!);
    AccessibilityInfo.sendAccessibilityEvent(focusTarget.current!, "focus");
    if (
      scene.operations.length !== requests + 2 ||
      otherScene.operations
        .slice(otherRequests)
        .some((operation) => operation.operation === "set" && operation.field === "gainFocus")
    )
      throw Error("Consumer accessibility focus did not use the target's owning root");
  } finally {
    otherRoot.unmount();
    otherInput.dispose();
  }
  if (observedFocus) throw Error("Consumer focus command fabricated an observation");
  const scrollTarget = [...scene.nodes.values()].find(
    (node) => node.fields.id === "scroll-target",
  )!;
  scene.emit(scrollTarget, "focusedChild", "scroll-target");
  for (let i = 0; i < 5; i++) await root.whenCommitted();
  let focusedY = -1;
  focusTarget.current!.measureInWindow((_x, y) => {
    focusedY = y;
  });
  if (observedFocus !== 1 || focusedY !== 20)
    throw Error(
      "Consumer focus did not reveal the observed descendant: " +
        JSON.stringify({ observedFocus, focusedY }),
    );
  const entry = createRef<import("react").ElementRef<typeof TextInput>>();
  root.render(createElement(TextInput, { ref: entry, nativeID: "entry", value: "fixture" }));
  await root.whenCommitted();
  const inputHandle = entry.current!,
    inputTag = findNodeHandle(inputHandle);
  if (!inputTag) throw Error("Consumer TextInput lost its host tag");
  // This host deliberately has no keyboard port: calling editing focus() would fail.
  AccessibilityInfo.sendAccessibilityEvent(inputHandle, "focus");
  root.render(
    createElement(TextInput, { ref: entry, nativeID: "renamed-entry", value: "fixture" }),
  );
  await root.whenCommitted();
  if (
    entry.current !== inputHandle ||
    !findNodeHandle(inputHandle) ||
    findNodeHandle(inputHandle) === inputTag
  )
    throw Error("Consumer stable TextInput alias did not follow native replacement");
  announcements.length = 0;
  const accessibilityControls = (checked: boolean) =>
    createElement(
      View,
      {},
      createElement(Text, { nativeID: "volume-label" }, "Volume"),
      createElement(Pressable, {
        nativeID: "accessible-checkbox",
        role: "checkbox",
        accessibilityLabel: "Include watched",
        accessibilityState: { checked },
      }),
      createElement(Pressable, {
        nativeID: "accessible-toggle",
        role: "button",
        accessibilityLabel: "Repeat",
        "aria-pressed": checked,
      }),
      createElement(Pressable, {
        nativeID: "accessible-slider",
        accessibilityRole: "adjustable",
        "aria-labelledby": "volume-label",
        accessibilityValue: { min: 0, max: 100, now: 25 },
      }),
      createElement(
        Text,
        { nativeID: "accessible-notice", "aria-live": "polite" },
        "Settings ready",
      ),
    );
  root.render(accessibilityControls(false));
  await root.whenCommitted();
  if (findNodeHandle(inputHandle) !== null)
    throw Error("Retired TextInput retained its native tag");
  const checkbox = [...scene.nodes.values()].find(
    (node) => node.fields.id === "accessible-checkbox",
  )!;
  scene.emit(checkbox, "focusedChild", "accessible-checkbox");
  await root.whenCommitted();
  root.render(accessibilityControls(true));
  await root.whenCommitted();
  const slider = [...scene.nodes.values()].find((node) => node.fields.id === "accessible-slider")!;
  scene.emit(slider, "focusedChild", "accessible-slider");
  await root.whenCommitted();
  for (const message of [
    "Settings ready",
    "Include watched, checkbox, not checked",
    "Include watched, checkbox, checked",
    "Volume, slider, 25, range 0 to 100",
  ])
    if (announcements.filter((value) => value === message).length !== 1)
      throw Error("Consumer accessibility semantics failed: " + message);
  root.render(
    createElement(
      View,
      {},
      accessibilityControls(true),
      createElement(
        View,
        { nativeID: "accessible-dialog", role: "dialog", "aria-modal": true },
        createElement(Pressable, {
          nativeID: "accessible-radio",
          accessibilityRole: "radio",
          accessibilityLabel: "Dark",
          accessibilityState: { checked: true },
        }),
      ),
    ),
  );
  await root.whenCommitted();
  if (input.isTargetEnabled("accessible-checkbox"))
    throw Error("Consumer modal admitted a background control");
  const radio = [...scene.nodes.values()].find((node) => node.fields.id === "accessible-radio")!;
  scene.emit(radio, "focusedChild", "accessible-radio");
  await root.whenCommitted();
  if (!announcements.includes("Dark, radio, checked"))
    throw Error("Consumer radio semantics failed");
  root.render(accessibilityControls(false));
  await root.whenCommitted();
  const toggle = [...scene.nodes.values()].find((node) => node.fields.id === "accessible-toggle")!;
  const speechBefore = announcements.length;
  scene.emit(toggle, "focusedChild", "accessible-toggle");
  root.render(accessibilityControls(true));
  await root.whenCommitted();
  root.render(accessibilityControls(true));
  await root.whenCommitted();
  if (
    JSON.stringify(announcements.slice(speechBefore)) !==
    JSON.stringify(["Repeat, button, not pressed", "Repeat, button, pressed"])
  )
    throw Error("Consumer toggle state was dropped or announced more than once");
  const retained = createRef<import("react-native-roku/react-native").NativeViewHandle>();
  let retainedPresses = 0;
  function EligibilityProbe({ open, hidden }: { open: boolean; hidden: boolean }) {
    useLayoutEffect(() => {
      if (!open && !hidden)
        AccessibilityInfo.setAccessibilityFocus(findNodeHandle(retained.current)!);
    }, [open, hidden]);
    return createElement(
      View,
      {},
      createElement(
        View,
        { style: { display: hidden ? "none" : "flex" } },
        createElement(Pressable, {
          ref: retained,
          nativeID: "retained-action",
          onPress: () => retainedPresses++,
        }),
      ),
      createElement(Text, {}, "Asynchronous native commit"),
      open
        ? createElement(
            View,
            { "aria-modal": true },
            createElement(Pressable, { nativeID: "probe-dialog" }),
          )
        : null,
    );
  }
  root.render(createElement(EligibilityProbe, { open: true, hidden: false }));
  await root.whenCommitted();
  root.render(createElement(EligibilityProbe, { open: false, hidden: false }));
  for (let i = 0; i < 4; i++) await root.whenCommitted();
  const retainedNode = [...scene.nodes.values()].find(
    (node) => node.fields.id === "retained-action",
  )!;
  if (retainedNode.fields.gainFocus !== true)
    throw Error("Consumer lost retained focus after modal dismissal");
  scene.emit(retainedNode, "focusedChild", "retained-action");
  input.dispatch({ key: "select", phase: "down" });
  root.render(createElement(EligibilityProbe, { open: false, hidden: true }));
  await root.whenCommitted();
  if (input.isTargetEnabled("retained-action")) throw Error("Consumer admitted a hidden target");
  root.render(createElement(EligibilityProbe, { open: false, hidden: false }));
  await root.whenCommitted();
  input.dispatch({ key: "select", phase: "up" });
  if (retainedPresses !== 0) throw Error("Consumer revived a retired held press");
  input.dispatch({ key: "select", phase: "down" });
  input.dispatch({ key: "select", phase: "up" });
  if (Number(retainedPresses) !== 1) throw Error("Consumer did not admit a fresh visible press");
  const remoteRef = createRef<import("react-native-roku/react-native").NativeViewHandle>();
  let remotePresses = 0;
  function RemoteProbe() {
    useLayoutEffect(() => remoteRef.current!.focus(), []);
    return createElement(
      View,
      {
        pointerEvents: "none",
        importantForAccessibility: "no-hide-descendants",
        style: { opacity: 0 },
      },
      createElement(Pressable, {
        ref: remoteRef,
        nativeID: "remote-action",
        onPress: () => remotePresses++,
      }),
      createElement(Text, {}, "Delayed focus preparation"),
    );
  }
  root.render(createElement(RemoteProbe));
  for (let i = 0; i < 4; i++) await root.whenCommitted();
  const remoteNode = [...scene.nodes.values()].find((node) => node.fields.id === "remote-action")!;
  if (!remoteNode.fields.focusable || !remoteNode.fields.gainFocus)
    throw Error("Touch/accessibility presentation blocked ordinary remote focus");
  scene.emit(remoteNode, "focusedChild", "remote-action");
  input.dispatch({ key: "select", phase: "down" });
  input.dispatch({ key: "select", phase: "up" });
  if (remotePresses !== 1) throw Error("Touch presentation blocked remote activation");
  const refusedRef = createRef<import("react-native-roku/react-native").NativeViewHandle>();
  let admittedPresses = 0;
  for (const blocked of ["modal", "hidden", "disabled", "focusable"]) {
    root.render(
      createElement(
        View,
        {},
        createElement(Pressable, {
          ref: refusedRef,
          nativeID: "refused-focus",
          disabled: blocked === "disabled",
          focusable: blocked === "focusable" ? false : undefined,
          style: { display: blocked === "hidden" ? "none" : "flex" },
        }),
        createElement(
          View,
          { "aria-modal": blocked === "modal" },
          createElement(Pressable, {
            nativeID: "admitted-focus",
            onPress: () => admittedPresses++,
          }),
        ),
      ),
    );
    for (let i = 0; i < 4; i++) await root.whenCommitted();
    const blockedNode = [...scene.nodes.values()].find(
      (node) => node.fields.id === "refused-focus",
    )!;
    if (blockedNode.fields.focusable !== false)
      throw Error("Native focus eligibility ignored " + blocked);
    input.observeFocus("admitted-focus", true);
    input.dispatch({ key: "select", phase: "down" });
    refusedRef.current!.focus();
    for (let i = 0; i < 4; i++) await root.whenCommitted();
    input.dispatch({ key: "select", phase: "up" });
  }
  if (admittedPresses !== 4) throw Error("Refused focus cancelled an admitted held press");
  const spatialOrigin = createRef<import("react-native-roku/react-native").NativeViewHandle>();
  root.render(
    createElement(
      View,
      { style: { width: 640, height: 360 } },
      createElement(Pressable, {
        ref: spatialOrigin,
        nativeID: "spatial-origin",
        style: { position: "absolute", left: 20, top: 100, width: 40, height: 40 },
      }),
      createElement(Pressable, {
        nativeID: "spatial-target",
        style: { position: "absolute", left: 100, top: 100, width: 40, height: 40 },
      }),
    ),
  );
  await root.whenCommitted();
  input.observeFocus("spatial-origin", true);
  scene.operations.length = 0;
  if (!input.dispatch({ key: "right", phase: "down" }) || input.focusedID !== "spatial-origin")
    throw Error("Packed spatial fallback fabricated focus or left the direction unhandled");
  const requestedSpatial = scene.operations
    .filter((op) => op.field === "gainFocus")
    .map((op) => scene.nodes.get(op.node)?.fields.id);
  if (JSON.stringify(requestedSpatial) !== '["spatial-target"]')
    throw Error("Packed spatial fallback did not request the eligible committed neighbor");
  input.observeFocus("spatial-target", true);
  input.observeFocus("spatial-origin", true);
  spatialOrigin.current!.setNativeProps({ nextFocusRight: null });
  scene.operations.length = 0;
  input.dispatch({ key: "right", phase: "down" });
  if (scene.operations.some((op) => op.field === "gainFocus"))
    throw Error("Packed spatial fallback escaped an explicit stop");
  const insetRef = createRef<import("react-native-roku/react-native").NativeViewHandle>();
  root.render(
    createElement(
      View,
      { style: { width: 100, height: 200 } },
      createElement(View, { ref: insetRef, style: { position: "absolute", inset: 5 } }),
    ),
  );
  await root.whenCommitted();
  const insetRect = await new Promise<number[]>((resolve) =>
    insetRef.current!.measure((x, y, width, height) => resolve([x, y, width, height])),
  );
  if (JSON.stringify(insetRect) !== "[5,5,90,190]") throw Error("Packed inset geometry failed");
  const nativeVideoErrors: Array<{ kind: string; snapshot: { error?: unknown } }> = [];
  root.render(
    createElement(SceneGraphVideo, {
      source: { uri: "https://fixture.invalid/video.m3u8", format: "hls" },
      paused: true,
      onObservation: (event) => nativeVideoErrors.push(event),
    }),
  );
  await root.whenCommitted();
  const video = [...scene.nodes.values()].find((node) => node.type === "video")!;
  scene.emit(video, "state", "error");
  scene.emit(video, "errorCode", -3);
  scene.emit(video, "errorInfo", {
    category: "http",
    errcode: 503,
    dbgmsg: "private-credential",
    source: "private-url",
  });
  scene.emit(video, "state", "error");
  if (
    nativeVideoErrors.filter((event) => event.kind === "error").length !== 1 ||
    nativeVideoErrors.filter((event) => event.kind === "error-details").length !== 2 ||
    JSON.stringify(nativeVideoErrors).includes("private-")
  )
    throw Error("Packed native video details duplicated recovery or retained raw diagnostics");
  const audioRef = createRef<SceneGraphAudioRef>(),
    observations: AudioObservation[] = [];
  root.render(
    createElement(SceneGraphAudio, {
      ref: audioRef,
      source: { uri: "https://fixture.invalid/opaque-audio", format: "mp3" },
      paused: true,
      onObservation: (event) => observations.push(event),
    }),
  );
  await root.whenCommitted();
  const audio = [...scene.nodes.values()].find((node) => node.type === "audio");
  if (!audio || !audio.fields.content || "width" in audio.fields || "visible" in audio.fields)
    throw Error("Consumer audio resource/content contract failed");
  audioRef.current!.seek(12);
  if (observations.length) throw Error("An audio command fabricated an observation");
  scene.emit(audio, "duration", 60);
  scene.emit(audio, "state", "paused");
  scene.emit(audio, "position", 12);
  if ((await audioRef.current!.getCurrentPosition()) !== 12)
    throw Error("Consumer audio position was not observed");
  if (observations.some((event) => event.snapshot.format !== undefined))
    throw Error("Admitted format became decoder evidence");
  const webRequests: WebRequest[] = [];
  const web = createPortableFetch(
    Object.assign(
      async (request: WebRequest) => {
        webRequests.push(request);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: '{"ok":true}',
        };
      },
      { redirectModes: ["error"] as const },
    ),
  );
  const reply = await web("https://fixture.invalid/api", {
    method: "PUT",
    body: "{}",
    redirect: "error",
    credentials: "omit",
  });
  if (
    !(await reply.json()).ok ||
    webRequests[0]?.redirect !== "error" ||
    webRequests[0]?.method !== "PUT" ||
    webRequests[0]?.body !== "{}"
  )
    throw Error("Consumer strict text HTTP contract failed");
  // Ordinary public props must survive packed installation and the shared host;
  // these observations qualify speech requests, not firmware announcement order.
  announcements.length = 0;
  const descriptorControls = (changed: boolean) =>
    createElement(
      View,
      {},
      createElement(Pressable, {
        nativeID: "descriptor-current",
        role: "link",
        accessibilityLabel: "Library",
        "aria-current": changed ? "page" : false,
      }),
      createElement(Pressable, {
        nativeID: "descriptor-popup",
        role: "button",
        accessibilityLabel: "Choose profile",
        "aria-haspopup": changed ? "dialog" : false,
      }),
      createElement(Pressable, {
        nativeID: "descriptor-heading",
        role: "heading",
        accessibilityLabel: "Chapter",
        "aria-level": changed ? 3 : undefined,
      }),
      createElement(Pressable, {
        nativeID: "descriptor-structure",
        role: "separator",
        accessibilityLabel: "Resize panel",
        "aria-orientation": changed ? "vertical" : "horizontal",
        "aria-roledescription": changed ? "resize handle" : undefined,
      }),
      createElement(View, {
        nativeID: "descriptor-notice",
        role: "status",
        "aria-roledescription": "notification",
        accessibilityLabel: changed ? "Queue updated" : "Queue ready",
      }),
      createElement(TextInput, {
        nativeID: "descriptor-secret",
        role: "textbox",
        accessibilityLabel: "Verification code",
        value: "descriptor-secret-value",
        secureTextEntry: true,
        "aria-live": "assertive",
        "aria-invalid": changed,
      }),
    );
  const focusDescriptor = async (id: string) => {
    const node = [...scene.nodes.values()].find((value) => value.fields.id === id)!;
    if (!node) throw Error("Packed accessibility descriptor control is absent: " + id);
    scene.emit(node, "focusedChild", id);
    await root.whenCommitted();
  };
  root.render(descriptorControls(false));
  await root.whenCommitted();
  for (const id of ["current", "popup", "heading", "structure"])
    await focusDescriptor("descriptor-" + id);
  root.render(descriptorControls(true));
  await root.whenCommitted();
  const descriptorSpeechCount = announcements.length;
  root.render(descriptorControls(true));
  await root.whenCommitted();
  if (announcements.length !== descriptorSpeechCount)
    throw Error("Packed accessibility descriptor update was announced twice");
  for (const id of ["current", "popup", "heading"]) await focusDescriptor("descriptor-" + id);
  for (const message of [
    "Library, link",
    "Library, link, current page",
    "Choose profile, button",
    "Choose profile, button, has popup dialog",
    "Chapter, heading",
    "Chapter, heading, level 3",
    "Resize panel, separator, horizontal",
    "Resize panel, resize handle, vertical",
    "Queue ready, notification",
    "Queue updated, notification",
    "Verification code, textbox",
    "Verification code, textbox, invalid entry",
  ])
    if (!announcements.includes(message))
      throw Error("Packed accessibility descriptor was not observed: " + message);
  if (announcements.some((value) => value.includes("descriptor-secret-value")))
    throw Error("Packed accessibility descriptors exposed a secure field value");
  for (const node of scene.nodes.values())
    for (const field of [
      "aria-current",
      "aria-invalid",
      "aria-haspopup",
      "aria-level",
      "aria-orientation",
      "aria-roledescription",
    ])
      if (field in node.fields) throw Error("Fabricated native accessibility field: " + field);
  root.unmount();
  input.dispose();
  if (scene.nodes.size !== 1 || scene.listenerCount !== 0) throw Error("Consumer resources leaked");
  if (effectCleanups !== effectSetups) throw Error("Consumer StrictMode effects did not retire");
  return {
    status: "passed",
    strictEffects: { setups: effectSetups, cleanups: effectCleanups },
    inputEligibility: {
      modalRestore: true,
      hiddenPressRetired: true,
      refusedFocusPreservesHeldPress: true,
      spatialFallback: true,
    },
    texts,
    audioObservations: observations.length,
    nativeVideoErrorDetails: true,
    accessibilityFocus: { objectHandle: true, owningRoot: true, textInputAlias: true },
    accessibilityPressedState: true,
    accessibilityDescriptors: { state: true, structural: true, secureValueExcluded: true },
    accessibilityRelationships: await qualifyAccessibilityRelationships(),
    keyboard: await qualifyKeyboard(),
    collections: await qualifyCollections(),
    columnCollections: await qualifyColumnCollections(),
    horizontalCollections: await qualifyHorizontalCollections(),
    separatorCollections: await qualifySeparatorCollections(),
    modalLifetimes: await qualifyModalLifetimes(),
    imageLifetimes: await qualifyImageLifetimes(),
    rasterFailureLifetimes: await qualifyRasterFailureLifetimes(),
    accessibilityDescriptions: await qualifyAccessibilityDescriptions(),
    accessibilityRetirement: await qualifyAccessibilityRetirement(),
    collectionBoundaryStyles: await qualifyCollectionBoundaryStyles(),
    focusObservationLifetimes: await qualifyFocusObservationLifetimes(),
    collectionGeometryLifetimes: await qualifyCollectionGeometryLifetimes(),
    collectionViewability: await qualifyCollectionViewability(),
    cleanupLifetimes: await qualifyCleanupLifetimes(),
    rasterReservations: await qualifyRasterReservations(),
    backLifetimes: await qualifyBackLifetimes(),
    applicationOwnership: await qualifyApplicationOwnership(),
    animations: await qualifyAnimations(),
    paragraphLines,
    focusedY,
    nodesAfterUnmount: scene.nodes.size,
    listenersAfterUnmount: scene.listenerCount,
  };
}
