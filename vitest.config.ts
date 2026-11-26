import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  cacheDir: ".local/vite-cache",
  test: { include: ["src/**/*.test.ts"] },
  resolve: {
    alias: {
      "react-native": fileURLToPath(new URL("./src/react-native/index.ts", import.meta.url)),
      "react-native-svg": fileURLToPath(new URL("./src/vector/svg.ts", import.meta.url)),
    },
  },
});
