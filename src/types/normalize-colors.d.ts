/** The upstream pure parser ships Flow types; keep its narrow TypeScript contract here. */
declare module "@react-native/normalize-colors" {
  export default function normalizeColor(value: string | number): number | null;
}
