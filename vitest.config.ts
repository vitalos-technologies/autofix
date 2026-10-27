import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  resolve: {
    alias: {
      "server-only": fileURLToPath(new URL("./src/__tests__/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    maxWorkers: 1,
    // userEvent-heavy component tests take ~4 s locally and longer on the shared CI VM; 5 s (the default) was too tight.
    testTimeout: 20_000,
  },
});
