import { RokuHostError } from "../scene/sceneGraph.types";
// The beta launcher currently supplies application routes directly. No native URL source is installed.
export const getInitialURL = async (): Promise<null> => null;
export const useLinkingURL = (): null => null;
export const useURL = useLinkingURL;
export const canOpenURL = async (): Promise<boolean> => false;
export async function openURL(): Promise<never> {
  throw new RokuHostError(
    "C09_EXTERNAL_URL",
    "The Roku launcher has no external URL capability installed",
  );
}
