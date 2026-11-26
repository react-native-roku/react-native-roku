import {
  prepareRokuProject,
  buildRokuProject,
  buildRokuPreview,
  devRokuProject,
} from "react-native-roku/build/project";
import { rokuBuildProfile, type RokuBuildProfile } from "react-native-roku/build/environment";

/** Type-only consumer coverage; qualification never invokes SDK builds or a watcher here. */
export async function configureBuildProfiles(root: string) {
  const compilation = rokuBuildProfile("development");
  const profile: RokuBuildProfile = compilation.name;
  const prepared = await prepareRokuProject(root, { frontend: false, profile });
  const preparedProfile: RokuBuildProfile = prepared.profile;
  const built = await buildRokuProject(root, { profile: "production" });
  const builtProfile: RokuBuildProfile = built.profile;
  const preview: string = await buildRokuPreview(root, { profile: "development" });
  const server: Promise<void> = devRokuProject(root, { profile: "development" });
  return { preparedProfile, builtProfile, preview, server, defines: compilation.defines };
}

export function rejectUnknownBuildProfiles(root: string) {
  // @ts-expect-error Runtime admits only the two reviewed compilation profiles.
  rokuBuildProfile("unknown");
  // @ts-expect-error Preparation must not accept a typo as a profile.
  prepareRokuProject(root, { profile: "unknown" });
  // @ts-expect-error SDK packaging uses the same profile contract.
  buildRokuProject(root, { profile: "unknown" });
  // @ts-expect-error Browser packaging uses the same profile contract.
  buildRokuPreview(root, { profile: "unknown" });
  // @ts-expect-error Watch mode uses the same profile contract.
  devRokuProject(root, { profile: "unknown" });
}
