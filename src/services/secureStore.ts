import { nativeDeviceServices } from "../react-native/environment";
import { RokuHostError } from "../scene/sceneGraph.types";
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = "roku-device-private";
export const getItemAsync = async (key: string) =>
  nativeDeviceServices().storage.read("secure", key);
export async function setItemAsync(
  key: string,
  value: string,
  options?: { keychainAccessible?: string; requireAuthentication?: boolean },
) {
  if (
    options?.requireAuthentication ||
    (options?.keychainAccessible != null &&
      options.keychainAccessible !== WHEN_UNLOCKED_THIS_DEVICE_ONLY)
  )
    throw new RokuHostError(
      "C21_SECRET_POLICY",
      "This secure-store policy requires a device capability that Roku does not provide",
    );
  await nativeDeviceServices().storage.write("secure", key, value);
}
export const deleteItemAsync = async (key: string) =>
  nativeDeviceServices().storage.write("secure", key, null);
