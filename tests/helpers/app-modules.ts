/**
 * App modules (`src/…`) for browser specs that must run app code in the test process, such as the job
 * runner with a pinned clock (tests/e2e/gate3.spec.ts). Playwright's own loader cannot import them: they
 * import `server-only` (resolved only by Next's bundler) and `@/…`. jiti (already a dev dependency) loads
 * them with the same aliases as vitest.config.ts, `server-only` included.
 *
 *   const runner = await importAppModule<typeof import("../../src/lib/jobs/runner")>("src/lib/jobs/runner.ts");
 *
 * Modules are cached per test worker, so every caller shares one instance (and one mock outbox).
 */
import { resolve } from "node:path";
import { createJiti } from "jiti";

const root = resolve(__dirname, "../..");

const loader = createJiti(__filename, {
  alias: {
    "server-only": resolve(root, "src/__tests__/server-only.ts"),
    "@/": `${resolve(root, "src")}/`,
  },
  jsx: true,
});

/** Loads `path` (relative to the repository root) through jiti. */
export function importAppModule<T>(path: string): Promise<T> {
  return loader.import<T>(resolve(root, path));
}
