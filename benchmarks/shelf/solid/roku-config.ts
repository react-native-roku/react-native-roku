import type { RokuConfig } from "@roku-sdk/rsg-ts/roku-config";

export default {
  outDir: "dist/sdk",
  app: {
    entryPoint: "src/App.tsx",
    images: { convertToWebp: false, generateHd: false },
    manifestEntries: {
      title: "Native Shelf Diagnostics",
      major_version: 0,
      minor_version: 1,
      build_version: 0,
      ui_resolutions: "fhd",
      rsg_version: "2.0",
      run_as_process: 1,
      sdk_instant_resume: 1,
    },
  },
} satisfies RokuConfig;
