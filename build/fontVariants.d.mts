import type { FontFamilyGroups } from "../src/layout/fontFaces.mjs";
export declare function deriveTabularFont(input: Uint8Array): {
  bytes: Uint8Array;
  family: string;
  sourceSha256: string;
  digitAdvance: number;
  characters: number;
};
export declare function prepareRokuFontAssets(options: {
  assets: Readonly<Record<string, string>>;
  families?: FontFamilyGroups;
  variants?: readonly "tabular-nums"[];
  outputDirectory: string;
}): {
  assets: Record<string, string>;
  families: FontFamilyGroups;
  faces: Array<{
    family: string;
    fontFamily?: string;
    path: string;
    sha256: string;
    sourceSha256: string;
    features: string[];
    digitAdvance?: number;
    characters?: number;
  }>;
};
