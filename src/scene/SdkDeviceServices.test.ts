import { beforeEach, expect, it, vi } from "vitest";
import { createSdkDeviceServices } from "./SdkDeviceServices";
import { encodeUtf8 } from "../services/utf8";

// Synthetic native ports exercise the codec and registry contract, not encryption.
const native = vi.hoisted(() => ({
  values: new Map<string, string>(),
  plaintexts: new Map<number, Uint8Array>(),
  sequence: 0,
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  flush: vi.fn(),
}));
vi.mock("@roku-sdk/runtime/registry", () => ({
  getRegistry: async () => ({
    create: (section: string) => ({
      read: (key: string) => native.values.get(`${section}/${key}`) ?? null,
      exists: (key: string) => native.values.has(`${section}/${key}`),
      write(key: string, value: string) {
        native.values.set(`${section}/${key}`, value);
        return true;
      },
      delete: (key: string) => native.values.delete(`${section}/${key}`),
    }),
    flush: native.flush,
  }),
}));
vi.mock("@roku-sdk/runtime/crypto", () => ({
  subtle: { encrypt: native.encrypt, decrypt: native.decrypt },
  randomUUID: vi.fn(),
  getRandomBytes: vi.fn(),
}));

beforeEach(() => {
  native.values.clear();
  native.plaintexts.clear();
  native.sequence = 0;
  native.flush.mockReset().mockResolvedValue(true);
  native.encrypt.mockReset().mockImplementation(async (_algorithm, _key, data: ArrayBuffer) => {
    const id = ++native.sequence;
    native.plaintexts.set(id, new Uint8Array(data).slice());
    return new Uint8Array([id]).buffer;
  });
  native.decrypt.mockReset().mockImplementation(async (_algorithm, _key, data: ArrayBuffer) => {
    const plaintext = native.plaintexts.get(new Uint8Array(data)[0]);
    if (!plaintext) throw Error("synthetic native decryption failure");
    return plaintext.slice().buffer;
  });
});

it.each([
  "",
  "ordinary",
  "🪵 café 東京",
  "\u0000embedded\u0000",
  "\ud800",
  '["react-native-roku",2,"nested"]',
])("round-trips arbitrary logical secure strings: %j", async (value) => {
  const services = await createSdkDeviceServices({ namespace: "fixture" });
  await services.storage.write("secure", "key", value);
  expect(await services.storage.read("secure", "key")).toBe(value);
  expect(native.flush).toHaveBeenCalledOnce();
  expect(new Uint8Array(native.encrypt.mock.calls[0][2]).byteLength).toBeGreaterThan(0);
  expect([...native.values.values()][0]).toMatch(/^pdr2:/);
  expect(native.encrypt.mock.calls[0][0]).toBe("DeviceCrypto");
  expect(native.encrypt.mock.calls[0][1]).toMatchObject({
    algorithm: { name: "device" },
    extractable: false,
  });
});

it("keeps missing, empty and deleted values distinct across service instances and namespaces", async () => {
  const first = await createSdkDeviceServices({ namespace: "first" });
  const other = await createSdkDeviceServices({ namespace: "other" });
  expect(await first.storage.read("secure", "key")).toBeNull();
  await first.storage.write("secure", "key", "");
  expect(await other.storage.read("secure", "key")).toBeNull();
  const reopened = await createSdkDeviceServices({ namespace: "first" });
  expect(await reopened.storage.read("secure", "key")).toBe("");
  await reopened.storage.write("secure", "key", null);
  expect(await first.storage.read("secure", "key")).toBeNull();
});

it("reads existing nonempty pdr1 credentials without rewriting them", async () => {
  native.values.set("fixture-secure/key", "pdr1:07");
  native.plaintexts.set(7, encodeUtf8("legacy-🪵"));
  const services = await createSdkDeviceServices({ namespace: "fixture" });
  expect(await services.storage.read("secure", "key")).toBe("legacy-🪵");
  expect(native.values.get("fixture-secure/key")).toBe("pdr1:07");
  expect(native.encrypt).not.toHaveBeenCalled();
  expect(native.flush).not.toHaveBeenCalled();
});

it("preserves the old credential without writing or flushing after failed or empty encryption", async () => {
  const services = await createSdkDeviceServices({ namespace: "fixture" });
  await services.storage.write("secure", "key", "old");
  const before = native.values.get("fixture-secure/key");
  native.encrypt.mockRejectedValueOnce(Error("synthetic unavailable"));
  await expect(services.storage.write("secure", "key", "replacement")).rejects.toThrow(
    "synthetic unavailable",
  );
  native.encrypt.mockResolvedValueOnce(new ArrayBuffer(0));
  await expect(services.storage.write("secure", "key", "replacement")).rejects.toThrow(
    "C21_SECRET_STORAGE",
  );
  expect(native.flush).toHaveBeenCalledOnce();
  expect(native.values.get("fixture-secure/key")).toBe(before);
  expect(await services.storage.read("secure", "key")).toBe("old");
});

it("rejects empty native decryptions for either format without inventing an empty credential", async () => {
  const services = await createSdkDeviceServices({ namespace: "fixture" });
  for (const prefix of ["pdr1:", "pdr2:"]) {
    native.values.set("fixture-secure/key", `${prefix}07`);
    native.plaintexts.set(7, new Uint8Array(0));
    await expect(services.storage.read("secure", "key")).rejects.toThrow("C21_SECRET_STORAGE");
  }
  expect(native.flush).not.toHaveBeenCalled();
});

it("refuses damaged or wrong-version envelopes and recovers the queue for later valid reads", async () => {
  const services = await createSdkDeviceServices({ namespace: "fixture" });
  native.values.set("fixture-secure/key", "pdr2:07");
  for (const plaintext of [
    "legacy text",
    "null",
    "[]",
    '["other",2,""]',
    '["react-native-roku",3,""]',
    '["react-native-roku",2,null]',
    '["react-native-roku",2,"",true]',
    '["react-native-roku",2,"',
  ]) {
    native.plaintexts.set(7, encodeUtf8(plaintext));
    await expect(services.storage.read("secure", "key")).rejects.toThrow("C21_SECRET_STORAGE");
  }
  native.plaintexts.set(7, new Uint8Array([255]));
  await expect(services.storage.read("secure", "key")).rejects.toThrow("C21_SECRET_STORAGE");
  native.plaintexts.set(7, encodeUtf8('["react-native-roku",2,""]'));
  expect(await services.storage.read("secure", "key")).toBe("");
  expect(native.flush).not.toHaveBeenCalled();
});

it("refuses unknown formats, malformed hex and absent ciphertext before native decryption", async () => {
  const services = await createSdkDeviceServices({ namespace: "fixture" });
  for (const value of ["plaintext", "pdr3:07", "pdr2:", "pdr1:", "pdr2:0", "pdr2:zz", "pdr1:zz"]) {
    native.values.set("fixture-secure/key", value);
    await expect(services.storage.read("secure", "key")).rejects.toThrow("C21_SECRET_STORAGE");
  }
  expect(native.decrypt).not.toHaveBeenCalled();
  expect(native.flush).not.toHaveBeenCalled();
});

it("restores the prior ciphertext when a replacement flush fails", async () => {
  const services = await createSdkDeviceServices({ namespace: "fixture" });
  await services.storage.write("secure", "key", "old");
  const before = native.values.get("fixture-secure/key");
  native.flush.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await expect(services.storage.write("secure", "key", "")).rejects.toThrow("C21_STORAGE_FLUSH");
  expect(native.values.get("fixture-secure/key")).toBe(before);
  expect(await services.storage.read("secure", "key")).toBe("old");
});
