import { dirname, extname, resolve } from "node:path";

/** The pinned 0.2.6 standalone observable hooks subscribe during render but
 * omit unmount cleanup. Keep this correction target-scoped and reject drift. */
export function retainNativewindHookLifetimes(source) {
  const colorNeedle =
    "    (0, observable_1.cleanupEffect)(effect);\n    return {\n        colorScheme:";
  const variableNeedle = "    let value = (0, styles_1.getVariable)(name, context, effect);";
  if (source.split(colorNeedle).length !== 2 || source.split(variableNeedle).length !== 2)
    throw Error(
      "Review the pinned NativeWind observable-hook lifetimes before updating the Roku adapter",
    );
  return source
    .replace(
      colorNeedle,
      `    (0, react_1.useEffect)(() => {\n        appearance_observables_1.colorScheme.get(effect);\n        return () => (0, observable_1.cleanupEffect)(effect);\n    }, [effect]);\n${colorNeedle}`,
    )
    .replace(
      variableNeedle,
      `    (0, react_1.useEffect)(() => {\n        const current = (0, styles_1.getVariable)(name, context, effect);\n        if (current && typeof current === "object" && "get" in current) current.get(effect);\n        return () => (0, observable_1.cleanupEffect)(effect);\n    }, [effect, name, context]);\n${variableNeedle}`,
    );
}

/** Resolve only the approved portable NativeWind engine's native-style leaves. */
export function nativewindLeaf(specifier, importer, require) {
  if (
    !specifier.startsWith(".") ||
    !/[\\/]node_modules[\\/](?:nativewind|react-native-css-interop)[\\/]/.test(importer)
  )
    return null;
  const base = resolve(dirname(importer), specifier),
    extension = extname(base);
  const candidates = extension
    ? [base.slice(0, -extension.length) + ".native" + extension]
    : [base + ".native.js", resolve(base, "index.native.js")];
  for (const path of candidates) {
    try {
      return require.resolve(path);
    } catch {}
  }
  return null;
}

/** Pinned NativeWind registration interop; consumer-specific CSS stays outside. */
export function prepareNativewindInterop(
  source,
  interopModule = "react-native-roku/interop/nativewind",
) {
  const needle = "exports.interopComponents.set(baseComponent, component);";
  const registration = "exports.interopComponents = new Map();";
  for (const value of [needle, registration])
    if (source.split(value).length !== 2)
      throw Error(
        "Review the pinned NativeWind component registry before updating the Roku adapter",
      );
  return retainNativewindHookLifetimes(source)
    .replace(
      needle,
      `if (baseComponent === require("react-native").Pressable) component = require(${JSON.stringify(interopModule)}).withPressableStyleCallbacks(component);\n${needle}`,
    )
    .replace(
      registration,
      `${registration}\nrequire(${JSON.stringify(interopModule)}).installStyleInterop(component => exports.interopComponents.get(component) || component);`,
    );
}

export function prepareNativewindPreferences(source) {
  const needle = ".isReduceMotionEnabled()?.then(exports.isReduceMotionEnabled.set);";
  if (source.split(needle).length !== 2)
    throw Error("Review the pinned NativeWind preference probe before updating the Roku adapter");
  return source.replace(
    needle,
    '.isReduceMotionEnabled()?.then(exports.isReduceMotionEnabled.set, error => { if (error?.code !== "C25_PREFERENCE_PENDING") throw error; console.warn("ROKU_PREFERENCE_PENDING", error.message); });',
  );
}

/** TextInput already owns focus events. A synthetic no-op press for its focus
 * styles must not turn the adapter's internal text display into pressable text.
 * Keep authored press props explicit, and preserve the other component paths. */
export function prepareNativewindInputState(source) {
  const needle = `            handlers.onPress = (event) => {
                sharedState.originalProps?.onPress?.(event);
            };`;
  if (source.split(needle).length !== 2)
    throw Error("Review the pinned NativeWind state-event bridge before updating the Roku adapter");
  return source.replace(
    needle,
    `            if (component !== react_native_1.TextInput || sharedState.originalProps?.onPress) {
${needle}
            }`,
  );
}
