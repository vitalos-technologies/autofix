// Copies this repository's Actions secrets and variables into the Vercel project's environment
// variables, so GitHub is the one place they are kept. Run by .github/workflows/vercel-env.yml.
// Secrets become Vercel "sensitive" variables (never readable again in the dashboard); variables
// become "encrypted" ones. Values are never printed, only names.
//
// Env: SECRETS_JSON and VARS_JSON (toJSON(secrets) / toJSON(vars)), VERCEL_API_TOKEN,
// VERCEL_PROJECT_ID, VERCEL_TEAM_ID, VERCEL_TARGETS (comma separated: production,preview).

// CI-only entries that the app never reads.
const SKIP = new Set(["github_token", "SUPABASE_DB_PASSWORD", "SUPABASE_PROJECT_REF", "RUNS_ON"]);
const SKIP_PREFIXES = ["GITHUB_", "ACTIONS_", "RUNNER_"];
const ALLOWED_TARGETS = new Set(["production", "preview"]);

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`sync-vercel-env: ${name} is not set.`);
    process.exit(1);
  }
  return value;
}

const token = required("VERCEL_API_TOKEN");
const projectId = required("VERCEL_PROJECT_ID");
const teamId = required("VERCEL_TEAM_ID");
const targets = required("VERCEL_TARGETS").split(",").map((target) => target.trim()).filter(Boolean);
if (targets.length === 0 || targets.some((target) => !ALLOWED_TARGETS.has(target))) {
  console.error(`sync-vercel-env: VERCEL_TARGETS must list production and/or preview, got "${process.env.VERCEL_TARGETS}".`);
  process.exit(1);
}

const secrets = JSON.parse(process.env.SECRETS_JSON || "{}");
const vars = JSON.parse(process.env.VARS_JSON || "{}");
const entries = [
  ...Object.entries(vars).map(([key, value]) => ({ key, value, type: "encrypted" })),
  // A secret wins over a variable of the same name.
  ...Object.entries(secrets).map(([key, value]) => ({ key, value, type: "sensitive" })),
].filter(({ key, value }) => !SKIP.has(key) && !SKIP_PREFIXES.some((prefix) => key.startsWith(prefix)) && value !== "");

const byKey = new Map(entries.map((entry) => [entry.key, entry]));
const url = `https://api.vercel.com/v10/projects/${encodeURIComponent(projectId)}/env?upsert=true&teamId=${encodeURIComponent(teamId)}`;

let failed = 0;
for (const { key, value, type } of [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key))) {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ key, value, type, target: targets }),
  });
  if (response.ok) {
    console.log(`set ${key} (${type}) for ${targets.join(", ")}`);
    continue;
  }
  failed += 1;
  const body = await response.json().catch(() => ({}));
  console.error(`failed ${key}: HTTP ${response.status} ${body.error?.code ?? ""} ${body.error?.message ?? ""}`.trim());
}

console.log(`${byKey.size - failed} of ${byKey.size} set. Redeploy in Vercel for a running deployment to pick them up.`);
if (failed > 0) process.exit(1);
