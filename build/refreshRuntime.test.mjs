import assert from "node:assert/strict";
import test from "node:test";
import { installRokuRefreshRuntime } from "./refreshRuntime.mjs";

function fixture(global) {
  const calls = [];
  const Refresh = {
    injectIntoGlobalHook(value) {
      assert.equal(value, global);
      calls.push("hook");
    },
    createSignatureFunctionForTransform() {},
    isLikelyComponentType() {},
    getFamilyByType() {},
    register() {},
    performReactRefresh() {
      calls.push("refresh");
    },
  };
  const runtime = installRokuRefreshRuntime(
    Refresh,
    { sessionId: "session", generation: 1 },
    global,
  );
  return { runtime, calls };
}

test("the refresh error bridge reports startup errors without poisoning Metro's guard and restores owned globals", async () => {
  const reported = [],
    global = {
      reportError(error) {
        reported.push(error.message);
      },
    };
  const { runtime } = fixture(global);
  assert.doesNotThrow(() => global.ErrorUtils.reportFatalError(Error("optional module failed")));
  assert.deepEqual(reported, ["optional module failed"]);
  assert.equal(runtime.snapshot().error, "optional module failed");
  runtime.attachRuntime(
    { sessionId: "session", generation: 1 },
    { __r: { getModules: () => new Map() } },
  );
  assert.equal(
    (await runtime.applyUpdate({ sessionId: "session", fromGeneration: 1, generation: 2 })).type,
    "reload",
  );
  assert.throws(() => runtime.beginPatch({}), /unrequested/);
  runtime.dispose();
  runtime.dispose();
  for (const name of ["ErrorUtils", "__ReactRefresh", "__RNR_ROKU_REFRESH__"])
    assert.equal(Object.hasOwn(global, name), false, name);
  assert.equal(runtime.snapshot().disposed, true);
});

test("refresh refuses stale/unattested update delivery and preserves another owner's replacement handlers", async () => {
  const original = { reportFatalError() {} },
    global = { ErrorUtils: original };
  const { runtime } = fixture(global);
  runtime.attachRuntime(
    { sessionId: "session", generation: 1 },
    { __r: { getModules: () => new Map([[1, { isInitialized: true }]]) } },
  );
  runtime.setApplication({ whenCommitted: async () => {} });
  const update = {
    sessionId: "session",
    fromGeneration: 1,
    generation: 2,
    updateId: "a".repeat(64),
    moduleIds: [1],
    paths: ["/refresh/update-" + "a".repeat(64) + "-0.mjs"],
  };
  for (const invalid of [
    { ...update, sessionId: "other" },
    { ...update, fromGeneration: 0 },
    { ...update, generation: 3 },
    { ...update, moduleIds: [99] },
    { ...update, moduleIds: [1, 1] },
    { ...update, paths: ["https://example.invalid/update.mjs"] },
    { ...update, paths: [...update.paths, ...update.paths] },
  ])
    assert.equal((await runtime.applyUpdate(invalid)).type, "reload");
  const replacement = { reportFatalError() {} },
    otherRefresh = {};
  global.ErrorUtils = replacement;
  global.__ReactRefresh = otherRefresh;
  runtime.dispose();
  assert.equal(global.ErrorUtils, replacement);
  assert.equal(global.__ReactRefresh, otherRefresh);
});

test("the bridge attaches after Metro's error-guard replacement and retires its handler without replacing that API", () => {
  const reported = [],
    global = { reportError: (error) => reported.push(error.message) };
  const { runtime } = fixture(global);
  const original = (error) => {
    throw error;
  };
  let handler = original;
  const polyfill = {
    getGlobalHandler: () => handler,
    setGlobalHandler: (value) => {
      handler = value;
    },
    reportFatalError: (error) => handler(error),
    applyWithGuard() {
      return "guard";
    },
  };
  global.ErrorUtils = polyfill;
  runtime.attachRuntime(
    { sessionId: "session", generation: 1 },
    { __r: { getModules: () => new Map() } },
  );
  assert.equal(global.ErrorUtils, polyfill);
  assert.equal(global.ErrorUtils.applyWithGuard(), "guard");
  assert.doesNotThrow(() => global.ErrorUtils.reportFatalError(Error("guarded failure")));
  assert.deepEqual(reported, ["guarded failure"]);
  runtime.dispose();
  assert.equal(global.ErrorUtils, polyfill);
  assert.equal(handler, original);
});
