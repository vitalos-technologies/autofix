import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  globalIgnores([
    ".next/**",
    ".claude/**",
    "output/**",
    "node_modules/**",
    "playwright-report/**",
    "test-results/**",
    "**/.wrangler/**",
    "**/.wrangler-dry-run/**",
    // The Django super admin (P5.1) has its own tooling (ruff, bandit; superadmin/README.md).
    "superadmin/**",
  ]),
]);
