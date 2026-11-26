import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { retainNativewindHookLifetimes } from "./nativewind.mjs";
import * as nativewind from "./nativewind.mjs";

const require = createRequire(import.meta.url);
const source = readFileSync(
  require.resolve("react-native-css-interop/dist/runtime/native/api.js"),
  "utf8",
);
function harness() {
  const effects = new Set(),
    setups = [];
  let state,
    updates = 0;
  const observable = {
    get(effect) {
      effects.add(effect);
      effect.dependencies.add(() => effects.delete(effect));
      return "dark";
    },
    set() {
      for (const effect of [...effects]) effect.run();
    },
  };
  const cleanupEffect = (effect) => {
    for (const release of [...effect.dependencies]) release();
    effect.dependencies.clear();
  };
  const exports = {};
  runInNewContext(retainNativewindHookLifetimes(source), {
    exports,
    console,
    require(name) {
      if (name === "react")
        return {
          useState(initial) {
            state ??= initial();
            return [
              state,
              (updater) => {
                state = updater(state);
                updates++;
              },
            ];
          },
          useEffect(setup) {
            setups.push(setup);
          },
          useContext() {
            return {};
          },
        };
      if (name === "../observable") return { cleanupEffect };
      if (name === "./appearance-observables") return { colorScheme: observable };
      if (name === "./styles") return { getVariable: () => observable };
      return {};
    },
  });
  return { exports, observable, effects, setups, updates: () => updates };
}
for (const hook of ["useColorScheme", "useUnstableNativeVariable"])
  test(`${hook} unsubscribes and reacquires across StrictMode effect retirement`, () => {
    const host = harness();
    host.exports[hook]("--fixture");
    assert.equal(host.effects.size, 1);
    const setup = host.setups[0];
    let cleanup = setup();
    cleanup();
    assert.equal(host.effects.size, 0);
    cleanup = setup();
    host.observable.set();
    assert.equal(host.updates(), 1);
    cleanup();
    host.observable.set();
    assert.equal(host.updates(), 1);
    assert.equal(host.effects.size, 0);
  });
test("observable hook correction refuses dependency source drift", () => {
  assert.throws(
    () => retainNativewindHookLifetimes("changed upstream source"),
    /Review the pinned NativeWind/,
  );
});

test("registration interop uses the public runtime bridge and refuses upstream drift", async () => {
  const { prepareNativewindInterop } = await import("./nativewind.mjs");
  const prepared = prepareNativewindInterop(source);
  assert.match(prepared, /react-native-roku\/interop\/nativewind/);
  assert.match(prepared, /withPressableStyleCallbacks/);
  assert.match(prepared, /installStyleInterop/);
  assert.throws(
    () =>
      prepareNativewindInterop(source.replace("exports.interopComponents = new Map();", "changed")),
    /Review the pinned NativeWind/,
  );
});
test("preference correction preserves unexpected errors and handles only unknown native preference", async () => {
  const { prepareNativewindPreferences } = await import("./nativewind.mjs");
  const appearance = readFileSync(
    require.resolve("react-native-css-interop/dist/runtime/native/appearance-observables.js"),
    "utf8",
  );
  const prepared = prepareNativewindPreferences(appearance);
  assert.match(prepared, /error\?\.code !== "C25_PREFERENCE_PENDING"/);
  assert.match(prepared, /throw error/);
  assert.throws(
    () => prepareNativewindPreferences("changed upstream source"),
    /Review the pinned NativeWind/,
  );
});

test("TextInput focus styles do not invent a text press callback while authored events survive", () => {
  const upstream = readFileSync(
    require.resolve("react-native-css-interop/dist/runtime/native/native-interop.js"),
    "utf8",
  );
  const prepared = nativewind.prepareNativewindInputState?.(upstream) ?? upstream;
  const TextInput = {},
    View = {},
    Text = {},
    exports = {},
    changes = [];
  runInNewContext(prepared, {
    exports,
    console,
    require(name) {
      if (name === "react")
        return {
          useContext: () => ({}),
          useMemo: (work) => work(),
          useEffect() {},
          useState: (initial) => [{ ...initial, focus: { set: (value) => changes.push(value) } }],
        };
      if (name === "react-native") return { TextInput, View, Text };
      if (name === "./render-component")
        return {
          UpgradeState: { NONE: 0, SHOULD_UPGRADE: 1 },
          renderComponent: (_component, state, props) => ({ state, props }),
        };
      return {};
    },
  });
  const calls = [];
  const input = exports.interop(
    TextInput,
    [],
    { onFocus: () => calls.push("focus"), onBlur: () => calls.push("blur") },
    null,
  );
  assert.equal(input.props.onPress, undefined);
  input.props.onFocus({});
  input.props.onBlur({});
  assert.deepEqual(calls, ["focus", "blur"]);
  assert.deepEqual(changes, [true, false]);
  const authored = exports.interop(TextInput, [], { onPress: () => calls.push("authored") }, null);
  authored.props.onPress({});
  assert.equal(calls.at(-1), "authored");
  assert.equal(typeof exports.interop(Text, [], {}, null).props.onPress, "function");
  const view = exports.interop(View, [], {}, null);
  assert.equal(typeof view.props.onPress, "function");
  assert.equal(view.state.pressable, 1);
});

test("the input state bridge refuses changed upstream event construction", () => {
  assert.throws(
    () => nativewind.prepareNativewindInputState("changed upstream"),
    /Review the pinned NativeWind/,
  );
});
