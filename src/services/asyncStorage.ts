import { nativeDeviceServices } from "../react-native/environment";
const section = "preferences";
export const getItem = async (key: string) => nativeDeviceServices().storage.read(section, key);
export const setItem = async (key: string, value: string) =>
  nativeDeviceServices().storage.write(section, key, value);
export const removeItem = async (key: string) =>
  nativeDeviceServices().storage.write(section, key, null);
export const multiGet = (keys: readonly string[]) =>
  Promise.all(keys.map(async (key) => [key, await getItem(key)] as [string, string | null]));
export async function multiSet(entries: readonly (readonly [string, string])[]) {
  for (const [key, value] of entries) await setItem(key, value);
}
export async function multiRemove(keys: readonly string[]) {
  for (const key of keys) await removeItem(key);
}
export default Object.freeze({
  getItem,
  setItem,
  removeItem,
  multiGet,
  multiSet,
  multiRemove,
});
