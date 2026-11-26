import { getRegistry } from "@roku-sdk/runtime/registry";
import { getRandomBytes, randomUUID, subtle } from "@roku-sdk/runtime/crypto";
import type { CryptoKey } from "@roku-sdk/interfaces";
import { RegistryStorage } from "../services/RegistryStorage";
import type { DeviceServices } from "../services/DeviceServices";
import { decodeUtf8, encodeUtf8, fromHex, toHex } from "../services/utf8";
import { RokuHostError } from "./sceneGraph.types";
const deviceKey: CryptoKey = {
  type: "secret",
  extractable: false,
  algorithm: { name: "device" },
  usages: ["encrypt", "decrypt"],
};
export async function createSdkDeviceServices(
  options: { readonly namespace?: string } = {},
): Promise<DeviceServices> {
  const registry = await getRegistry();
  if (!registry) throw new RokuHostError("C21_STORAGE_HOST", "The device registry is unavailable");
  const storage = new RegistryStorage(
    registry,
    {
      async encode(value) {
        // Empty logical strings still need nonempty plaintext, so a failed native
        // decryption can never be mistaken for a successfully stored empty value.
        const encrypted = await subtle.encrypt(
          "DeviceCrypto",
          deviceKey,
          encodeUtf8(JSON.stringify(["react-native-roku", 2, value])).buffer as ArrayBuffer,
        );
        if (!encrypted.byteLength)
          throw new RokuHostError("C21_SECRET_STORAGE", "Device encryption returned no ciphertext");
        return `pdr2:${toHex(new Uint8Array(encrypted))}`;
      },
      async decode(value) {
        const legacy = value.startsWith("pdr1:");
        if (!legacy && !value.startsWith("pdr2:"))
          throw new RokuHostError("C21_SECRET_STORAGE", "Unrecognized device credential encoding");
        if (!/^(?:[0-9a-f]{2})+$/i.test(value.slice(5)))
          throw new RokuHostError("C21_SECRET_STORAGE", "Invalid device credential ciphertext");
        const decrypted = await subtle.decrypt(
          "DeviceCrypto",
          deviceKey,
          fromHex(value.slice(5)).buffer as ArrayBuffer,
        );
        if (!decrypted.byteLength)
          throw new RokuHostError("C21_SECRET_STORAGE", "Device decryption returned no credential");
        if (legacy) return decodeUtf8(new Uint8Array(decrypted));
        let envelope: unknown;
        try {
          envelope = JSON.parse(decodeUtf8(new Uint8Array(decrypted)));
        } catch {
          throw new RokuHostError("C21_SECRET_STORAGE", "Invalid device credential envelope");
        }
        if (
          !Array.isArray(envelope) ||
          envelope.length !== 3 ||
          envelope[0] !== "react-native-roku" ||
          envelope[1] !== 2 ||
          typeof envelope[2] !== "string"
        )
          throw new RokuHostError("C21_SECRET_STORAGE", "Invalid device credential envelope");
        return envelope[2];
      },
    },
    options.namespace,
  );
  return {
    storage,
    randomUUID,
    randomBytes: (length) => new Uint8Array(getRandomBytes(length)),
  };
}
