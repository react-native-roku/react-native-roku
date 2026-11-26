export type FontFamilyGroups = Readonly<
  Record<
    string,
    {
      readonly normal?: Readonly<Record<string, string>>;
      readonly italic?: Readonly<Record<string, string>>;
    }
  >
>;
export declare function prepareFontFamilies(
  assets: Readonly<Record<string, string>>,
  families?: FontFamilyGroups,
): FontFamilyGroups;
export declare function fontFaceFamily(
  family: string,
  style: { readonly fontWeight?: unknown; readonly fontStyle?: unknown },
  assets: Readonly<Record<string, string>>,
  families: FontFamilyGroups,
): string;
