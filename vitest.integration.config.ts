import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  // App modules (`@/lib/...`) are imported by the booking API integration tests.
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      "server-only": fileURLToPath(new URL("./src/__tests__/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/integration/**/*.test.ts"],
    maxWorkers: 1,
    hookTimeout: 60_000,
    testTimeout: 90_000,
  },
});
