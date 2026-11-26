import { nativeDeviceServices } from "../react-native/environment";
import { RokuHostError } from "../scene/sceneGraph.types";
export const randomUUID = () => nativeDeviceServices().randomUUID();
export function getRandomBytes(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0 || length > 65_536)
    throw new RokuHostError(
      "C21_RANDOM_LENGTH",
      "Secure random requests must be within 0..65536 bytes",
    );
  const result = nativeDeviceServices().randomBytes(length);
  if (!(result instanceof Uint8Array) || result.length !== length)
    throw new RokuHostError(
      "C21_RANDOM_HOST",
      "The native random port returned an invalid byte count",
    );
  return result;
}
export const getRandomBytesAsync = async (length: number) => getRandomBytes(length);
