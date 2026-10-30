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

// Names listed in vercel-env.yml but not set in GitHub (repository or organisation), so a missing key shows.
const unset = [...new Set(Object.keys(process.env)
  .filter((name) => (name.startsWith("SECRET__") || name.startsWith("VAR__")) && !clean(process.env[name]))
  .map((name) => name.replace(/^(SECRET|VAR)__/, "")))].filter((key) => !byKey.has(key)).sort();
if (unset.length) console.log(`not set in GitHub (skipped): ${unset.join(", ")}`);

// Stripe runs live only on purpose (STRIPE_LIVE_MODE "true", as the app): then only a live key reaches
// Vercel, otherwise only a test key. A refused key leaves Vercel's key and mode as they were, so they
// never disagree.
const stripeLive = byKey.get("STRIPE_LIVE_MODE")?.value === "true";
const stripeKey = byKey.get("STRIPE_SECRET_KEY");
if (stripeKey && !(stripeLive ? /^(sk|rk)_live_/ : /^(sk|rk)_test_/).test(stripeKey.value)) {
  byKey.delete("STRIPE_SECRET_KEY");
  byKey.delete("STRIPE_LIVE_MODE");
  console.error(
    stripeLive
      ? "skipped STRIPE_SECRET_KEY and STRIPE_LIVE_MODE: STRIPE_LIVE_MODE is true but the key is not a live key (sk_live_ or rk_live_); test keys are refused in live mode"
      : "skipped STRIPE_SECRET_KEY and STRIPE_LIVE_MODE: not a test-mode key (sk_test_ or rk_test_); a live key is used only when STRIPE_LIVE_MODE is true",
  );
}

// Modes and plan settings are not secret: show their values so the log says what production runs.
const SHOWN = /^(MESSAGING_MODE|BILLING_PROVIDER|BILLING_COLLECT_VAT|STRIPE_LIVE_MODE|PAYMENTS_PROVIDER|PLACES_PROVIDER|VEHICLE_LOOKUP_PROVIDER|VERCEL_DOMAINS_MODE|PLAN_[A-Z_]+|SMS_SEGMENT_COST_PENCE|LEGAL_COPY_APPROVED|COOKIE_CONFIGURATION_APPROVED)$/;
for (const [key, { value, type }] of byKey) if (type === "encrypted" && SHOWN.test(key)) console.log(`value ${key}=${value}`);

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
