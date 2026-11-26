import { expect, it } from "vitest";
import { installLanguageRuntime, relativeIndex } from "./languageRuntime";

it("implements relative indices for generic, sparse and UTF-16 receivers", () => {
  expect(relativeIndex.call({ length: 3, 2: "last" }, -1)).toBe("last");
  expect(relativeIndex.call([1, , 3], -2)).toBeUndefined();
  expect(relativeIndex.call([1, 2], 0.9)).toBe(1);
  expect(relativeIndex.call([1, 2], -0.9)).toBe(1);
  expect(relativeIndex.call([1, 2], NaN)).toBe(1);
  expect(relativeIndex.call([1, 2], Infinity)).toBeUndefined();
  expect(relativeIndex.call([1, 2], -3)).toBeUndefined();
  expect(relativeIndex.call("😀", 0)).toBe("\ud83d");
  expect(() => relativeIndex.call(null, 0)).toThrow(TypeError);
});
it("leases missing methods non-enumerably, preserving native functions and other mounted hosts", () => {
  const target = {
    Array: { prototype: {} },
    String: { prototype: {} },
    Object: {},
  } as unknown as Pick<typeof globalThis, "Array" | "String" | "Object">;
  const first = installLanguageRuntime(target),
    second = installLanguageRuntime(target);
  expect(target.Array.prototype.at.call([1, 2], -1)).toBe(2);
  expect(target.String.prototype.at.call("abc", -1)).toBe("c");
  expect(target.Object.hasOwn(Object.create({ inherited: true }), "inherited")).toBe(false);
  expect(target.Object.hasOwn({ own: undefined }, "own")).toBe(true);
  expect(Object.keys(target.Array.prototype)).toEqual([]);
  first();
  first();
  expect(typeof target.Array.prototype.at).toBe("function");
  second();
  expect("at" in target.Array.prototype).toBe(false);
  const native = Array.prototype.at,
    release = installLanguageRuntime();
  release();
  expect(Array.prototype.at).toBe(native);
});
