import { createElement, Fragment, StrictMode } from "react";
import { describe, expect, it } from "vitest";
import { RouterStore, type RouteParams } from "./RouterStore";
import {
  Redirect,
  RokuRouterProvider,
  router,
  useGlobalSearchParams,
  usePathname,
  useRouter,
} from "./expoRouter";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import { createSceneRoot } from "../renderer/SceneRoot";

const pathParams = (path: string): RouteParams =>
  path.startsWith("/movies/") ? { movieId: decodeURIComponent(path.slice(8)) } : {};

describe("location adapter mechanics", () => {
  it("dismisses to the most recent matching href while retaining its location identity", () => {
    const store = new RouterStore("/home");
    store.push("/library?tag=one&sort=title");
    const first = store.getSnapshot();
    store.push("/detail/1");
    store.push("/library?sort=title&tag=one");
    const latest = store.getSnapshot();
    store.push("/detail/2");
    let changes = 0;
    const remove = store.subscribe(() => changes++);
    store.dismissTo("/library?tag=one&sort=title");
    expect(store.getSnapshot()).toBe(latest);
    expect(changes).toBe(1);
    store.dismissTo("/library?sort=title&tag=one");
    expect(changes).toBe(1);
    store.back();
    store.back();
    expect(store.getSnapshot()).toBe(first);
    remove();
    store.dispose();
  });
  it("dismissTo replaces the current location when absent and leaves history intact on invalid input", () => {
    const store = new RouterStore("/home");
    const home = store.getSnapshot();
    store.push("/detail/1");
    store.dismissTo("/search?q=beta");
    expect(store.getSnapshot().href).toBe("/search?q=beta");
    const search = store.getSnapshot();
    expect(() => store.dismissTo("https://outside.invalid")).toThrow(/absolute application path/);
    expect(store.getSnapshot()).toBe(search);
    store.back();
    expect(store.getSnapshot()).toBe(home);
    store.dispose();
    expect(() => store.dismissTo("/home")).toThrow(/disposed/);
  });
  it("query values cannot change canonical path parameters or partially publish an invalid route", () => {
    expect(() => new RouterStore("/movies/42?movieId=43", pathParams)).toThrow(/path parameter/i);
    const store = new RouterStore("/movies/42", pathParams),
      current = store.getSnapshot();
    let changes = 0;
    const remove = store.subscribe(() => changes++);
    expect(() => store.push("/movies/42?movieId=43")).toThrow(/path parameter/i);
    expect(store.getSnapshot()).toBe(current);
    expect(changes).toBe(0);
    store.push("/movies/42?movieId=42&sort=title");
    expect(store.getSnapshot().params.movieId).toBe("42");
    remove();
    store.dispose();
  });
  it("canonical array parameters are immutable snapshots and compare by value", () => {
    const parts = ["one", "two"];
    const store = new RouterStore("/items/one/two", () => ({ parts }));
    const current = store.getSnapshot();
    parts[0] = "changed externally";
    expect(current.params.parts).toEqual(["one", "two"]);
    expect(Object.isFrozen(current.params.parts)).toBe(true);
    parts[0] = "one";
    expect(() => store.setParams({ parts: ["one", "two"] })).not.toThrow();
    expect(store.getSnapshot()).toBe(current);
    store.push("/items/one/two?parts=one&parts=two");
    expect(store.getSnapshot().params.parts).toEqual(["one", "two"]);
    store.dispose();
  });
  it("prototype-shaped query names remain ordinary values", () => {
    const store = new RouterStore("/search");
    store.setParams({ toString: "custom", constructor: "safe", ["__proto__"]: "opaque" });
    expect(store.getSnapshot().queryParams).toMatchObject({
      toString: "custom",
      constructor: "safe",
      ["__proto__"]: "opaque",
    });
    expect(Object.getPrototypeOf(store.getSnapshot().params)).toBe(Object.prototype);
    store.dispose();
  });
  it("formats dynamic hrefs while the caller supplies canonical path identity", () => {
    const store = new RouterStore("/", pathParams),
      home = store.getSnapshot();
    store.push({
      pathname: "/(tabs)/movies/[movieId]",
      params: { movieId: "42", sort: "a&b", tag: ["one", "two"] },
    });
    expect(store.getSnapshot()).toMatchObject({
      pathname: "/movies/42",
      href: "/movies/42?sort=a%26b&tag=one&tag=two",
      params: { movieId: "42", sort: "a&b", tag: ["one", "two"] },
    });
    expect(Object.isFrozen(store.getSnapshot().params.tag)).toBe(true);
    store.back();
    expect(store.getSnapshot()).toBe(home);
    expect(store.canGoBack()).toBe(false);
    store.dispose();
  });
  it("returns to retained location identity for singular navigation and ignores identical replacements", () => {
    const store = new RouterStore(),
      home = store.getSnapshot();
    let changes = 0;
    const remove = store.subscribe(() => {
      changes++;
    });
    store.replace("/");
    store.push("/library");
    store.push("/search");
    store.navigate("/", { dangerouslySingular: true });
    expect(store.getSnapshot()).toBe(home);
    expect(changes).toBe(3);
    expect(store.canGoBack()).toBe(false);
    remove();
    store.dispose();
    expect(store.listenerCount).toBe(0);
    expect(() => store.push("/library")).toThrow(/disposed/);
  });
  it("updates query parameters without duplicating or silently changing canonical path parameters", () => {
    const store = new RouterStore("/movies/42?sort=old&tag=a&tag=b", pathParams);
    store.setParams({ sort: "new", tag: undefined });
    expect(store.getSnapshot().href).toBe("/movies/42?sort=new");
    expect(store.getSnapshot().params.movieId).toBe("42");
    expect(() => store.setParams({ movieId: "43" })).toThrow(/explicit navigation/);
    store.dispose();
  });
  it("rejects external URLs and incomplete route interpolation", () => {
    for (const href of [
      "https://example.com",
      "//example.com",
      "../home",
      "/movies/[movieId]",
      "/a/../b",
    ])
      expect(() => new RouterStore(href)).toThrow();
    const store = new RouterStore({
      pathname: "/items/[...parts]",
      params: { parts: ["a b", "c"] },
    });
    expect(store.getSnapshot().pathname).toBe("/items/a%20b/c");
    store.dispose();
  });
  it("connects global navigation to React subscriptions and retires it with its provider", () => {
    const scene = new RecordingSceneGraph(),
      root = createSceneRoot(scene),
      store = new RouterStore();
    function Location() {
      const path = usePathname(),
        params = useGlobalSearchParams<{ q?: string }>();
      return createElement("label", {}, `${path}:${params.q ?? ""}`);
    }
    root.render(
      createElement(RokuRouterProvider, {
        store,
        children: createElement(Location),
      }),
    );
    root.runSync(() => router.push("/search?q=beta"));
    expect(scene.root.children[0].fields.text).toBe("/search:beta");
    expect(store.listenerCount).toBe(2);
    root.unmount();
    expect(store.listenerCount).toBe(0);
    expect(() => router.canGoBack()).toThrow(/mounted Roku router/);
    store.dispose();
  });
  it("executes a redirect through the location store", () => {
    const scene = new RecordingSceneGraph(),
      root = createSceneRoot(scene),
      store = new RouterStore("/profiles");
    function Location() {
      return createElement("label", {}, usePathname());
    }
    root.render(
      createElement(RokuRouterProvider, {
        store,
        children: createElement(
          Fragment,
          {},
          createElement(Redirect, { href: "/" }),
          createElement(Location),
        ),
      }),
    );
    root.flush();
    expect(store.getSnapshot().pathname).toBe("/");
    expect(scene.root.children[0].fields.text).toBe("/");
    root.unmount();
    store.dispose();
  });
  it("useRouter stays bound to its own root while another provider is mounted", () => {
    const sceneA = new RecordingSceneGraph(),
      sceneB = new RecordingSceneGraph();
    const rootA = createSceneRoot(sceneA),
      rootB = createSceneRoot(sceneB);
    const storeA = new RouterStore("/first"),
      storeB = new RouterStore("/second");
    let boundA!: ReturnType<typeof useRouter>;
    function Location() {
      boundA = useRouter();
      return createElement("label", {}, usePathname());
    }
    try {
      rootA.render(
        createElement(RokuRouterProvider, { store: storeA, children: createElement(Location) }),
      );
      const originalRouter = boundA;
      rootB.render(createElement(RokuRouterProvider, { store: storeB, children: null }));
      rootA.runSync(() => boundA.push("/first/next"));
      expect(storeA.getSnapshot().pathname).toBe("/first/next");
      expect(storeB.getSnapshot().pathname).toBe("/second");
      expect(sceneA.root.children[0].fields.text).toBe("/first/next");
      expect(boundA).toBe(originalRouter);
      rootA.runSync(() => boundA.dismissTo("/first"));
      expect(storeA.getSnapshot().pathname).toBe("/first");
      expect(storeB.getSnapshot().pathname).toBe("/second");
    } finally {
      rootA.unmount();
      rootB.unmount();
      storeA.dispose();
      storeB.dispose();
    }
  });
  it("out-of-order provider retirement cannot restore an unmounted global router", () => {
    const rootA = createSceneRoot(new RecordingSceneGraph()),
      rootB = createSceneRoot(new RecordingSceneGraph());
    const storeA = new RouterStore("/first"),
      storeB = new RouterStore("/second");
    try {
      rootA.render(createElement(RokuRouterProvider, { store: storeA, children: null }));
      rootB.render(createElement(RokuRouterProvider, { store: storeB, children: null }));
      rootA.unmount();
      rootB.runSync(() => router.push("/second/next"));
      expect(storeB.getSnapshot().pathname).toBe("/second/next");
      rootB.unmount();
      expect(() => router.push("/retired")).toThrow(/mounted Roku router/);
      expect(storeA.getSnapshot().pathname).toBe("/first");
    } finally {
      rootA.unmount();
      rootB.unmount();
      storeA.dispose();
      storeB.dispose();
    }
  });
  it("nested providers bind hooks to the nearest store and retire their own registration", () => {
    const root = createSceneRoot(new RecordingSceneGraph());
    const outer = new RouterStore("/outer"),
      inner = new RouterStore("/inner");
    let outerRouter!: ReturnType<typeof useRouter>, innerRouter!: ReturnType<typeof useRouter>;
    function Outer() {
      outerRouter = useRouter();
      return null;
    }
    function Inner() {
      innerRouter = useRouter();
      return null;
    }
    try {
      root.render(
        createElement(RokuRouterProvider, {
          store: outer,
          children: createElement(
            Fragment,
            {},
            createElement(Outer),
            createElement(RokuRouterProvider, { store: inner, children: createElement(Inner) }),
          ),
        }),
      );
      root.runSync(() => {
        innerRouter.push("/inner/next");
        outerRouter.push("/outer/next");
      });
      expect(inner.getSnapshot().pathname).toBe("/inner/next");
      expect(outer.getSnapshot().pathname).toBe("/outer/next");
      root.render(
        createElement(RokuRouterProvider, { store: outer, children: createElement(Outer) }),
      );
      root.runSync(() => router.dismissTo("/outer"));
      expect(outer.getSnapshot().pathname).toBe("/outer");
      expect(inner.getSnapshot().pathname).toBe("/inner/next");
      root.unmount();
      expect(() => router.canGoBack()).toThrow(/mounted Roku router/);
    } finally {
      root.unmount();
      outer.dispose();
      inner.dispose();
    }
  });
  it("provider replay and store replacement retire all global registrations", () => {
    const root = createSceneRoot(new RecordingSceneGraph());
    const first = new RouterStore("/first"),
      second = new RouterStore("/second");
    try {
      root.render(
        createElement(
          StrictMode,
          {},
          createElement(RokuRouterProvider, { store: first, children: null }),
        ),
      );
      root.runSync(() => router.push("/first/next"));
      expect(first.getSnapshot().pathname).toBe("/first/next");
      root.render(
        createElement(
          StrictMode,
          {},
          createElement(RokuRouterProvider, { store: second, children: null }),
        ),
      );
      root.runSync(() => router.push("/second/next"));
      expect(second.getSnapshot().pathname).toBe("/second/next");
      expect(first.getSnapshot().pathname).toBe("/first/next");
      root.unmount();
      expect(() => router.canGoBack()).toThrow(/mounted Roku router/);
    } finally {
      root.unmount();
      first.dispose();
      second.dispose();
    }
  });
});
