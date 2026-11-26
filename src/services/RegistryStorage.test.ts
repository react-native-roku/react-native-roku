import { describe, expect, it } from "vitest";
import { RegistryStorage, type RegistryPort, type RegistrySectionPort } from "./RegistryStorage";
import { decodeUtf8, encodeUtf8, fromHex, toHex } from "./utf8";
import { createNativeRoot } from "../react-native/createNativeRoot";
import { RecordingSceneGraph } from "../testing/RecordingSceneGraph";
import * as secure from "./secureStore";
import storage from "./asyncStorage";
import { getRandomBytes, randomUUID } from "./crypto";
class Registry implements RegistryPort {
  buffered = new Map<string, string>();
  durable = new Map<string, string>();
  outcomes: boolean[] = [];
  flushes = 0;
  beforeFlush?: () => Promise<void>;
  create(section: string): RegistrySectionPort {
    const key = (name: string) => `${section}/${name}`;
    return {
      read: (name) => this.buffered.get(key(name)) ?? null,
      write: (name, value) => {
        this.buffered.set(key(name), value);
        return true;
      },
      delete: (name) => this.buffered.delete(key(name)),
      exists: (name) => this.buffered.has(key(name)),
    };
  }
  async flush() {
    this.flushes++;
    await this.beforeFlush?.();
    const ok = this.outcomes.shift() ?? true;
    if (ok) this.durable = new Map(this.buffered);
    return ok;
  }
}
const fixtureCodec = {
  encode: async (value: string) => `fixture-cipher:${toHex(encodeUtf8(value))}`,
  decode: async (value: string) => decodeUtf8(fromHex(value.slice(15))),
};
describe("durable Roku device storage", () => {
  it("serializes overlapping writes and does not resolve a write before its flush", async () => {
    const registry = new Registry(),
      service = new RegistryStorage(registry);
    let release!: () => void,
      settled = 0;
    registry.beforeFlush = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const first = service.write("preferences", "one", "A").then(() => settled++);
    const second = service.write("preferences", "two", "B").then(() => settled++);
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.flushes).toBe(1);
    expect(settled).toBe(0);
    expect([...registry.durable]).toEqual([]);
    expect([...registry.buffered.values()]).toEqual(["A"]);
    registry.beforeFlush = undefined;
    release();
    await Promise.all([first, second]);
    expect(settled).toBe(2);
    expect([...registry.durable.values()]).toEqual(["A", "B"]);
  });
  it("rolls a failed write back and allows later work without poisoning the queue", async () => {
    const registry = new Registry(),
      service = new RegistryStorage(registry);
    await service.write("preferences", "theme", "old");
    registry.outcomes = [false, true];
    await expect(service.write("preferences", "theme", "new")).rejects.toThrow(/C21_STORAGE_FLUSH/);
    expect(await service.read("preferences", "theme")).toBe("old");
    expect([...registry.durable.values()]).toEqual(["old"]);
    await service.write("preferences", "theme", "final");
    expect(await service.read("preferences", "theme")).toBe("final");
    await service.write("preferences", "theme", null);
    expect(await service.read("preferences", "theme")).toBeNull();
  });
  it("refuses further access after an unconfirmed rollback", async () => {
    const registry = new Registry(),
      service = new RegistryStorage(registry);
    registry.outcomes = [false, false];
    await expect(service.write("preferences", "theme", "value")).rejects.toThrow(
      /C21_STORAGE_RECOVERY/,
    );
    await expect(service.read("preferences", "theme")).rejects.toThrow(/awaits app recovery/);
  });
  it("keeps credential ciphertext separate and refuses missing encryption capabilities", async () => {
    const registry = new Registry(),
      service = new RegistryStorage(registry, fixtureCodec);
    await service.write("secure", "device", "token-🪵-Alex");
    expect([...registry.durable.keys()]).toEqual(["react-native-roku-secure/device"]);
    expect([...registry.durable.values()][0]).not.toContain("token");
    expect(await service.read("secure", "device")).toBe("token-🪵-Alex");
    const missing = new RegistryStorage(registry);
    await expect(missing.read("secure", "device")).rejects.toThrow(/encryption is unavailable/);
    await expect(missing.write("secure", "second", "secret")).rejects.toThrow(
      /encryption is unavailable/,
    );
    await missing.write("secure", "device", null);
    expect(registry.durable.size).toBe(0);
  });
  it("executes existing storage/crypto API adapters against only the mounted device port", async () => {
    const registry = new Registry(),
      service = new RegistryStorage(registry, fixtureCodec);
    const root = createNativeRoot(new RecordingSceneGraph(), {
      viewport: { width: 800, height: 600 },
      text: {
        prepare() {},
        metrics: () => ({ lineHeight: 20, width: () => 10 }),
      },
      services: {
        storage: service,
        randomUUID: () => "fixture-uuid",
        randomBytes: (size) => new Uint8Array(size).fill(7),
      },
    });
    await storage.setItem("connection", "server");
    await secure.setItemAsync("credential", "token", {
      keychainAccessible: secure.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    expect(await storage.getItem("connection")).toBe("server");
    expect(await secure.getItemAsync("credential")).toBe("token");
    expect(randomUUID()).toBe("fixture-uuid");
    expect(getRandomBytes(3)).toEqual(new Uint8Array([7, 7, 7]));
    await expect(
      secure.setItemAsync("credential", "token", {
        requireAuthentication: true,
      }),
    ).rejects.toThrow(/device capability/);
    root.unmount();
    expect(() => randomUUID()).toThrow(/mounted Roku root/);
    expect(() => getRandomBytes(-1)).toThrow(/C21_RANDOM_LENGTH/);
  });
  it("matches standard UTF-8 encoding, round-trips Unicode, and rejects corrupt encodings", () => {
    const samples = ["", "ASCII", "Crème brûlée", "日本語", "👩🏽‍💻", "a\ud800b"];
    let seed = 123;
    for (let sample = 0; sample < 500; sample++) {
      let value = "";
      for (let index = 0; index < 24; index++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
        value += String.fromCharCode(seed & 0xffff);
      }
      samples.push(value);
    }
    for (const value of samples) {
      const bytes = new TextEncoder().encode(value);
      expect(encodeUtf8(value)).toEqual(bytes);
      expect(decodeUtf8(bytes)).toBe(new TextDecoder().decode(bytes));
    }
    for (const bytes of [
      [0xc0, 0x80],
      [0xed, 0xa0, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
      [0xe2, 0x82],
    ])
      expect(() => decodeUtf8(new Uint8Array(bytes))).toThrow(/Invalid UTF-8/);
    expect(() => fromHex("f")).toThrow(/encoding/);
    expect(() => fromHex("gg")).toThrow(/encoding/);
  });
});
