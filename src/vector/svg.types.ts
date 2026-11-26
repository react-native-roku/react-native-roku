export interface SvgAtlasEntry {
  readonly variants: Readonly<Record<string, string>>;
}
export type SvgAtlas = Readonly<Record<string, SvgAtlasEntry>>;
