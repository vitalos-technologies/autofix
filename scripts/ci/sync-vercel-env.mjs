// Copies repository Actions secrets and variables into the Vercel project's environment variables,
// so GitHub is the one place they are kept. Run by .github/workflows/vercel-env.yml, which names each
// one it passes: SECRET__<NAME> becomes a Vercel "sensitive" variable (never readable again in the
// dashboard), VAR__<NAME> an "encrypted" one. Empty values (not set in GitHub yet) are skipped.
// Values are never printed, only names.
//
// Also reads SECRET__VERCEL_API_TOKEN, VAR__VERCEL_PROJECT_ID, VAR__VERCEL_TEAM_ID and VERCEL_TARGETS
// (comma separated: production,preview).

const ALLOWED_TARGETS = new Set(["production", "preview"]);

// Values piped into `gh secret set` from Windows PowerShell 5.1 start with a byte-order mark; a stray
// newline is just as invisible. Neither belongs in a key, and a BOM breaks the Authorization header.
function clean(value) {
  return (value ?? "").replace(/^﻿/, "").trim();
}

function required(name) {
  const value = clean(process.env[name]);
  if (!value) {
    console.error(`sync-vercel-env: ${name} is not set.`);
    process.exit(1);
  }
  return value;
}

const token = required("SECRET__VERCEL_API_TOKEN");
const projectId = required("VAR__VERCEL_PROJECT_ID");
const teamId = required("VAR__VERCEL_TEAM_ID");
const targets = required("VERCEL_TARGETS").split(",").map((target) => target.trim()).filter(Boolean);
if (targets.length === 0 || targets.some((target) => !ALLOWED_TARGETS.has(target))) {
  console.error(`sync-vercel-env: VERCEL_TARGETS must list production and/or preview, got "${process.env.VERCEL_TARGETS}".`);
  process.exit(1);
}

const byKey = new Map();
for (const [name, raw] of Object.entries(process.env)) {
  const value = clean(raw);
  if (value && name.startsWith("VAR__")) byKey.set(name.slice(5), { value, type: "encrypted" });
}
// A secret wins over a variable of the same name.
for (const [name, raw] of Object.entries(process.env)) {
  const value = clean(raw);
  if (value && name.startsWith("SECRET__")) byKey.set(name.slice(8), { value, type: "sensitive" });
}

const url = `https://api.vercel.com/v10/projects/${encodeURIComponent(projectId)}/env?upsert=true&teamId=${encodeURIComponent(teamId)}`;

let failed = 0;
for (const [key, { value, type }] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
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
