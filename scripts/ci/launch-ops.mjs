// Gate 4 launch steps (docs/autofix/LAUNCH.md), run from GitHub Actions with the repository's secrets and
// variables (.github/workflows/launch-ops.yml), so nobody pastes a key into a chat or a terminal.
//
//   LAUNCH_TASK   report | vercel-domains | vercel-secrets | twilio-webhooks | resend-domain | supabase-migrate | supabase-auth
//                 | stripe-setup
//   LAUNCH_APPLY  "true" to change anything; otherwise every task only reports what it would do.
//
// Prints names, statuses, hosts and public DNS records only: never a secret value. Phone numbers are
// shown by their last four digits.

import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const TASKS = ["report", "vercel-domains", "vercel-secrets", "twilio-webhooks", "resend-domain", "supabase-migrate", "supabase-auth", "stripe-setup"];
// Cloudflare zone of vitalos.co.uk (docs/autofix/INFRA.md); CLOUDFLARE_ZONE_ID overrides it.
const DEFAULT_ZONE_ID = "99115a2bb8d6630faff3cb8151e1f35c";
const MIGRATIONS_DIR = "supabase/migrations";
// One table or column each migration adds, read through PostgREST with the service key.
const MIGRATION_PROBES = [
  ["20261026000000", "enquiries?select=id"],
  ["20261026000100", "garage_members?select=garage_id"],
  ["20261027000100", "resources?select=id"],
  ["20261028000100", "agent_tokens?select=id"],
  ["20261028000200", "customer_imports?select=id"],
  ["20261028000300", "garage_agreements?select=id"],
  ["20261028000400", "garage_invites?select=id"],
  ["20261028000500", "platform_impersonations?select=id"],
  ["20261028001000", "reminder_rules?select=id"],
  ["20261028002000", "twilio_webhook_events?select=event_key"],
  ["20261028002100", "calls?select=dial_status"],
  ["20261028003000", "messages?select=read_at"],
  // 20261028004000 (superadmin_role) only adds a database role, which PostgREST can't see.
  ["20261029000100", "garages?select=trial_ends_at"],
  ["20261029000300", "health_checks?select=id"],
  ["20261029000400", "payments?select=id"],
  ["20261029000500", "campaigns?select=id"],
  ["20261029000600", "booking_assignments?select=booking_id"],
  ["20261029000700", "business_accounts?select=id"],
  ["20261029000800", "courtesy_cars?select=id"],
  ["20261029000900", "garage_groups?select=id"],
  ["20261029001000", "accounting_connections?select=id"],
  ["20261029001100", "service_plans?select=id"],
  ["20261029001200", "ai_front_desk_settings?select=*"],
  // 20261029001300 (askbridge_site_key) only changes functions and settings, which PostgREST can't probe.
  ["20261029001400", "customers?select=offers_consent"],
  ["20261029002000", "calls?select=ai_summary"],
];

// Same cleaning as sync-vercel-env.mjs: no byte-order mark, no stray whitespace.
function clean(value) {
  return (value ?? "").replace(/^﻿/, "").trim();
}
const env = (name) => clean(process.env[name]) || null;

const task = env("LAUNCH_TASK") ?? "report";
// `report` never changes anything, whatever LAUNCH_APPLY says.
const apply = task !== "report" && env("LAUNCH_APPLY") === "true";
if (!TASKS.includes(task)) {
  console.error(`launch-ops: LAUNCH_TASK must be one of ${TASKS.join(", ")}, got "${task}".`);
  process.exit(1);
}

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.log(`  FAIL ${message}`);
};
const heading = (title) => console.log(`\n== ${title}${apply ? "" : " (report only)"}`);

function missing(names) {
  const absent = names.filter((name) => !env(name));
  if (absent.length) console.log(`  not set in GitHub: ${absent.join(", ")}`);
  return absent.length > 0;
}

async function call(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { ok: response.ok, status: response.status, body };
}

function errorText(result) {
  const error = result.body?.error ?? result.body;
  const code = error?.code ?? error?.name ?? "";
  const message = error?.message ?? result.body?.message ?? result.body?.raw ?? "";
  return `HTTP ${result.status} ${code} ${message}`.replace(/\s+/g, " ").trim();
}

// Every name the tasks read, so a secret saved under the wrong name (or in the wrong place) shows at once.
const KEYS = [
  "VERCEL_API_TOKEN", "VERCEL_PROJECT_ID", "VERCEL_TEAM_ID", "NEXT_PUBLIC_SITE_URL",
  "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_MESSAGING_SERVICE_SID",
  "RESEND_API_KEY", "RESEND_ADMIN_API_KEY", "RESEND_FROM_EMAIL", "CLOUDFLARE_API_TOKEN",
  "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY", "SUPABASE_ACCESS_TOKEN", "STRIPE_SECRET_KEY",
];
function keysLine() {
  console.log(`keys this run can see: ${KEYS.map((name) => `${name}=${env(name) ? "set" : "MISSING"}`).join(" ")}`);
}

const lastFour = (phone) => (phone ? `…${String(phone).slice(-4)}` : "none");

function siteOrigin() {
  const site = env("NEXT_PUBLIC_SITE_URL") ?? "https://autofix.vitalos.co.uk";
  const url = new URL(site);
  if (url.protocol !== "https:") throw new Error("NEXT_PUBLIC_SITE_URL must be https");
  return url.origin;
}

// ---------------------------------------------------------------------------------------------------------
// Vercel: attach the admin host and the wildcard for free garage links (LAUNCH 3.2)
// ---------------------------------------------------------------------------------------------------------

async function vercelDomains() {
  heading("Vercel domains");
  if (missing(["VERCEL_API_TOKEN", "VERCEL_PROJECT_ID", "VERCEL_TEAM_ID"])) return fail("Vercel is not configured");
  const token = env("VERCEL_API_TOKEN");
  const project = encodeURIComponent(env("VERCEL_PROJECT_ID"));
  const team = `teamId=${encodeURIComponent(env("VERCEL_TEAM_ID"))}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const adminHost = env("NEXT_PUBLIC_ADMIN_HOST") ?? "autofix.vitalos.co.uk";
  const tenantRoot = env("NEXT_PUBLIC_TENANT_ROOT_DOMAIN") ?? "autofix.vitalos.co.uk";
  const hosts = [...new Set([adminHost, `*.${tenantRoot}`])];

  for (const host of hosts) {
    let domain = await call(`https://api.vercel.com/v9/projects/${project}/domains/${encodeURIComponent(host)}?${team}`, { headers });
    if (domain.status === 404) {
      if (!apply) {
        console.log(`  ${host}: not on the project (would add)`);
        continue;
      }
      domain = await call(`https://api.vercel.com/v10/projects/${project}/domains?${team}`, { method: "POST", headers, body: JSON.stringify({ name: host }) });
      if (!domain.ok) {
        fail(`${host}: add failed, ${errorText(domain)}`);
        continue;
      }
      console.log(`  ${host}: added to the project`);
    } else if (!domain.ok) {
      fail(`${host}: ${errorText(domain)}`);
      continue;
    }
    if (domain.body?.verified === false && apply) {
      const verified = await call(`https://api.vercel.com/v9/projects/${project}/domains/${encodeURIComponent(host)}/verify?${team}`, { method: "POST", headers });
      if (verified.ok) domain = verified;
    }
    console.log(`  ${host}: verified=${domain.body?.verified}`);
    for (const record of domain.body?.verification ?? []) {
      console.log(`    needs ${record.type} ${record.domain} = ${record.value} (${record.reason ?? "verification"})`);
    }
    const config = await call(`https://api.vercel.com/v6/domains/${encodeURIComponent(host)}/config?${team}&projectIdOrName=${project}`, { headers });
    if (config.ok) {
      console.log(`    dns: misconfigured=${config.body?.misconfigured} configuredBy=${config.body?.configuredBy ?? "none"} challenges=${(config.body?.acceptedChallenges ?? []).join(",") || "none"}`);
    } else {
      console.log(`    dns: ${errorText(config)}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Vercel: the app's own random secrets (LAUNCH 3.3), generated here so nobody makes or pastes them
// ---------------------------------------------------------------------------------------------------------

// Created only where missing, never replaced: rotating one revokes agent tokens, retires sent manage and
// unsubscribe links, empties the vehicle cache or disconnects every accounting connection. Production and
// Preview get different values, made in this job and sent only to Vercel (type sensitive, so nobody can
// read them back). [name, encoding, random bytes]
const GENERATED_SECRETS = [
  ["BOOKING_MANAGEMENT_SECRET", "base64url", 48],
  ["BOOKING_STATE_SECRET", "base64url", 48],
  ["CRON_SECRET", "base64url", 48],
  ["VEHICLE_FACTS_PEPPER", "base64url", 48],
  ["AGENT_TOKEN_PEPPER", "base64url", 48],
  ["ACCOUNTING_TOKEN_KEY", "hex", 32],
];
const SECRET_TARGETS = ["production", "preview"];

// Project, team and headers for the Vercel REST API (call only after `missing()` found all three names).
function vercelApi() {
  return {
    project: encodeURIComponent(env("VERCEL_PROJECT_ID")),
    team: `teamId=${encodeURIComponent(env("VERCEL_TEAM_ID"))}`,
    headers: { Authorization: `Bearer ${env("VERCEL_API_TOKEN")}`, "Content-Type": "application/json" },
  };
}

// The project's env vars (names, types and targets; no values).
async function vercelEnvs({ project, team, headers }) {
  const list = await call(`https://api.vercel.com/v9/projects/${project}/env?${team}`, { headers });
  // A branch-only Preview value does not cover the other branches.
  return { list, envs: list.ok ? (list.body?.envs ?? []).filter((entry) => !entry.gitBranch) : [] };
}

// Production reads its variables at build time: rebuild the current production deployment with them.
async function redeployProduction({ project, team, headers }, readyMessage) {
  const deployments = await call(`https://api.vercel.com/v6/deployments?projectId=${project}&target=production&state=READY&limit=1&${team}`, { headers });
  const current = deployments.body?.deployments?.[0];
  if (!deployments.ok || !current) return fail(`no ready production deployment to redeploy (${errorText(deployments)}); redeploy by hand`);
  const redeploy = await call(`https://api.vercel.com/v13/deployments?${team}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: current.name, deploymentId: current.uid, target: "production" }),
  });
  if (!redeploy.ok) return fail(`redeploy: ${errorText(redeploy)}; redeploy by hand`);
  console.log(`  redeploying production (${current.uid} -> ${redeploy.body.id})`);
  const deadline = Date.now() + 12 * 60 * 1000;
  for (;;) {
    const state = (await call(`https://api.vercel.com/v13/deployments/${encodeURIComponent(redeploy.body.id)}?${team}`, { headers })).body?.readyState;
    if (state === "READY") return console.log(`  ${readyMessage}`);
    if (state === "ERROR" || state === "CANCELED") return fail(`the redeploy ended ${state}`);
    if (Date.now() > deadline) return fail("the redeploy was not ready within 12 minutes; check it in Vercel");
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
}

async function vercelSecrets() {
  heading("Vercel generated secrets");
  if (missing(["VERCEL_API_TOKEN", "VERCEL_PROJECT_ID", "VERCEL_TEAM_ID"])) return fail("Vercel is not configured");
  const vercel = vercelApi();
  const { project, team, headers } = vercel;

  const { list, envs } = await vercelEnvs(vercel);
  if (!list.ok) return fail(`env list: ${errorText(list)}`);

  let productionChanged = false;
  for (const [name, encoding, bytes] of GENERATED_SECRETS) {
    const targets = new Set(envs.filter((entry) => entry.key === name).flatMap((entry) => entry.target ?? []));
    const absent = SECRET_TARGETS.filter((target) => !targets.has(target));
    if (!absent.length) {
      console.log(`  ${name}: set (${SECRET_TARGETS.join(", ")})`);
      continue;
    }
    if (!apply) {
      console.log(`  ${name}: missing for ${absent.join(", ")} (would generate)`);
      continue;
    }
    for (const target of absent) {
      const value = randomBytes(bytes).toString(encoding);
      const created = await call(`https://api.vercel.com/v10/projects/${project}/env?${team}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ key: name, value, type: "sensitive", target: [target] }),
      });
      if (!created.ok) {
        fail(`${name} (${target}): ${errorText(created)}`);
        continue;
      }
      console.log(`  ${name}: generated for ${target}`);
      if (target === "production") productionChanged = true;
    }
  }
  if (!productionChanged) return;
  await redeployProduction(vercel, "production redeployed with the new secrets");
}

// ---------------------------------------------------------------------------------------------------------
// Twilio: Messaging Service inbound + delivery receipts, voice numbers (LAUNCH 6.2)
// ---------------------------------------------------------------------------------------------------------

async function twilioWebhooks() {
  heading("Twilio webhooks");
  if (missing(["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_MESSAGING_SERVICE_SID"])) return fail("Twilio is not configured");
  const account = env("TWILIO_ACCOUNT_SID");
  const service = env("TWILIO_MESSAGING_SERVICE_SID");
  const headers = { Authorization: `Basic ${Buffer.from(`${account}:${env("TWILIO_AUTH_TOKEN")}`).toString("base64")}` };
  const form = (fields) => ({ method: "POST", headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
  const origin = siteOrigin();
  const ours = new URL(origin).host;
  const want = { sms: `${origin}/api/webhooks/twilio/sms`, status: `${origin}/api/webhooks/twilio/status`, voice: `${origin}/api/webhooks/twilio/voice` };

  const svc = await call(`https://messaging.twilio.com/v1/Services/${service}`, { headers });
  if (!svc.ok) return fail(`Messaging Service: ${errorText(svc)}`);
  console.log(`  Messaging Service "${svc.body.friendly_name}": inbound=${svc.body.inbound_request_url || "none"} status=${svc.body.status_callback || "none"} numberWebhooks=${svc.body.use_inbound_webhook_on_number}`);

  const all = await call(`https://api.twilio.com/2010-04-01/Accounts/${account}/IncomingPhoneNumbers.json?PageSize=100`, { headers });
  const inService = await call(`https://messaging.twilio.com/v1/Services/${service}/PhoneNumbers?PageSize=100`, { headers });
  if (!all.ok || !inService.ok) return fail(`phone numbers: ${errorText(all.ok ? inService : all)}`);
  const serviceSids = new Set((inService.body.phone_numbers ?? []).map((number) => number.sid));
  const numbers = all.body.incoming_phone_numbers ?? [];
  console.log(`  account has ${numbers.length} number(s); ${serviceSids.size} in this Messaging Service`);
  for (const number of numbers) {
    const voiceHost = number.voice_url ? new URL(number.voice_url).host : "none";
    console.log(`    ${lastFour(number.phone_number)} "${number.friendly_name}" ${serviceSids.has(number.sid) ? "in service" : "not in service"}: voice=${voiceHost} status=${number.status_callback ? new URL(number.status_callback).host : "none"}`);
  }

  if (!apply) {
    console.log(`  would set the service to inbound ${want.sms} and receipts ${want.status}, and each service number's voice + call status to ${want.voice}`);
    return;
  }

  const updated = await call(`https://messaging.twilio.com/v1/Services/${service}`, form({ InboundRequestUrl: want.sms, InboundMethod: "POST", StatusCallback: want.status, UseInboundWebhookOnNumber: "false" }));
  if (updated.ok) console.log(`  Messaging Service: inbound + receipts point at ${ours}`);
  else fail(`Messaging Service update: ${errorText(updated)}`);

  for (const number of numbers.filter((candidate) => serviceSids.has(candidate.sid))) {
    const current = number.voice_url ? new URL(number.voice_url).host : null;
    // Never take over a number another app answers (the account may be shared with other Vitalos products).
    if (current && current !== ours && !current.endsWith("twilio.com")) {
      console.log(`    ${lastFour(number.phone_number)}: left alone, its calls go to ${current}`);
      continue;
    }
    const result = await call(
      `https://api.twilio.com/2010-04-01/Accounts/${account}/IncomingPhoneNumbers/${number.sid}.json`,
      form({ VoiceUrl: want.voice, VoiceMethod: "POST", StatusCallback: want.voice, StatusCallbackMethod: "POST" }),
    );
    if (result.ok) console.log(`    ${lastFour(number.phone_number)}: voice + call status point at ${ours}`);
    else fail(`${lastFour(number.phone_number)}: ${errorText(result)}`);
  }
  console.log("  Each garage number still needs a garage_phone_numbers row with its provider_sid (PN…) before calls and texts route to a garage.");
}

// ---------------------------------------------------------------------------------------------------------
// Resend: the sending domain and its DNS records in Cloudflare (LAUNCH 5.1)
// ---------------------------------------------------------------------------------------------------------

function sendingDomain() {
  const from = env("RESEND_FROM_EMAIL");
  const match = from ? /@([a-z0-9.-]+)>?\s*$/i.exec(from) : null;
  return match ? match[1].toLowerCase() : null;
}

/** Resend names records relative to either the added domain or its zone; pick the one inside the domain. */
export function recordFqdn(name, domain, zone) {
  if (!name || name === "@") return domain;
  if (name.endsWith(`.${zone}`) || name === zone) return name;
  const inZone = `${name}.${zone}`;
  return inZone === domain || inZone.endsWith(`.${domain}`) ? inZone : `${name}.${domain}`;
}

async function resendDomain() {
  heading("Resend sending domain");
  if (missing(["RESEND_FROM_EMAIL"])) return fail("Resend is not configured");
  const domain = sendingDomain();
  if (!domain) return fail("RESEND_FROM_EMAIL has no domain");
  // The app's RESEND_API_KEY may be send-only; managing domains needs a full-access key.
  const key = env("RESEND_ADMIN_API_KEY") ?? env("RESEND_API_KEY");
  if (!key) return fail("RESEND_ADMIN_API_KEY (full access) is not set");
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

  const list = await call("https://api.resend.com/domains", { headers });
  if (!list.ok) {
    if (list.body?.name === "restricted_api_key") console.log("  Add a full-access Resend key as the repository secret RESEND_ADMIN_API_KEY (Resend → API Keys → Full access).");
    return fail(`Resend domains: ${errorText(list)}`);
  }
  let found = (list.body?.data ?? []).find((entry) => entry.name === domain);
  if (!found) {
    if (!apply) {
      console.log(`  ${domain}: not in Resend (would add, region eu-west-1)`);
      return;
    }
    const created = await call("https://api.resend.com/domains", { method: "POST", headers, body: JSON.stringify({ name: domain, region: "eu-west-1" }) });
    if (!created.ok) return fail(`${domain}: add failed, ${errorText(created)}`);
    found = created.body;
    console.log(`  ${domain}: added to Resend`);
  }
  const detail = await call(`https://api.resend.com/domains/${found.id}`, { headers });
  if (!detail.ok) return fail(`${domain}: ${errorText(detail)}`);
  const records = detail.body.records ?? [];
  console.log(`  ${domain}: status=${detail.body.status}`);

  const cfToken = env("CLOUDFLARE_API_TOKEN");
  const zoneId = env("CLOUDFLARE_ZONE_ID") ?? DEFAULT_ZONE_ID;
  const cf = { Authorization: `Bearer ${cfToken}`, "Content-Type": "application/json" };
  let zone = null;
  if (cfToken) {
    const zoneResult = await call(`https://api.cloudflare.com/client/v4/zones/${zoneId}`, { headers: cf });
    if (zoneResult.ok) zone = zoneResult.body.result.name;
    else fail(`Cloudflare zone: ${errorText(zoneResult)}`);
  } else {
    console.log("  not set in GitHub: CLOUDFLARE_API_TOKEN (records below must be added by hand)");
  }

  for (const record of records) {
    const fqdn = zone ? recordFqdn(record.name, domain, zone) : `${record.name} (relative to ${domain} or its zone)`;
    console.log(`    ${record.record} ${record.type} ${fqdn} = ${record.value}${record.priority ? ` (priority ${record.priority})` : ""}: ${record.status}`);
    if (!apply || !zone || record.status === "verified") continue;
    const query = new URLSearchParams({ type: record.type, name: fqdn });
    const existing = await call(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?${query}`, { headers: cf });
    if (!existing.ok) {
      fail(`Cloudflare lookup ${fqdn}: ${errorText(existing)}`);
      continue;
    }
    const same = (existing.body.result ?? []).find((entry) => entry.content.replace(/^"|"$/g, "") === record.value);
    if (same) {
      console.log("      already in Cloudflare");
      continue;
    }
    // Only TXT and MX may sit beside others of their kind; never replace a record someone else made.
    if ((existing.body.result ?? []).length && !["TXT", "MX"].includes(record.type)) {
      console.log(`      left alone: ${fqdn} already has a different ${record.type} record`);
      continue;
    }
    const body = { type: record.type, name: fqdn, content: record.value, ttl: 1, proxied: false, comment: "Autofix (Resend sending domain)" };
    if (record.type === "MX") body.priority = Number(record.priority ?? 10);
    const created = await call(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, { method: "POST", headers: cf, body: JSON.stringify(body) });
    if (created.ok) console.log("      added in Cloudflare");
    else fail(`Cloudflare add ${fqdn}: ${errorText(created)}`);
  }

  if (apply && detail.body.status !== "verified") {
    const verify = await call(`https://api.resend.com/domains/${found.id}/verify`, { method: "POST", headers });
    console.log(`  verification requested: ${verify.ok ? "ok (Resend checks DNS over the next minutes; run again to see the status)" : errorText(verify)}`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Supabase: migrations over the Management API, auth settings (LAUNCH 4.3, 4.4, 4.4a)
// ---------------------------------------------------------------------------------------------------------

function projectRef() {
  const url = env("NEXT_PUBLIC_SUPABASE_URL");
  const match = url ? /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(url) : null;
  return match ? match[1] : null;
}

const quote = (text) => `'${String(text).replaceAll("'", "''")}'`;

function localMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{14}_.+\.sql$/.test(file))
    .sort()
    .map((file) => ({ version: file.slice(0, 14), name: file.slice(15, -4), file: path.join(MIGRATIONS_DIR, file) }));
}

async function supabase() {
  heading(task === "supabase-auth" ? "Supabase auth" : "Supabase database");
  const ref = projectRef();
  if (!ref) return fail("NEXT_PUBLIC_SUPABASE_URL is not a https://<ref>.supabase.co URL");
  console.log(`  project ref ${ref}`);

  // Without a Management API token, the service key can still show which migrations' tables and
  // columns exist (migrations that only add functions are not checked this way).
  const secretKey = env("SUPABASE_SECRET_KEY");
  if (secretKey) {
    const keyHeaders = { apikey: secretKey, Authorization: `Bearer ${secretKey}` };
    const garages = await call(`https://${ref}.supabase.co/rest/v1/garages?select=id&limit=1`, { headers: keyHeaders });
    console.log(`  public.garages: ${garages.ok ? `exists (${(garages.body ?? []).length ? "has rows" : "empty"})` : `not reachable (${errorText(garages)})`}`);
    const found = [];
    const absent = [];
    for (const [version, probe] of MIGRATION_PROBES) {
      const result = await call(`https://${ref}.supabase.co/rest/v1/${probe}&limit=0`, { headers: keyHeaders });
      // A missing table is a 404; anything else (a wrong column, a refused key) says why, so a bad probe shows.
      if (result.ok) found.push(`${version} (${probe.split("?")[0]})`);
      else absent.push(`${version} (${probe.split("?")[0]})${result.status === 404 ? "" : `: ${errorText(result)}`}`);
    }
    console.log(`  migration tables/columns present: ${found.length}/${MIGRATION_PROBES.length}`);
    for (const entry of absent) console.log(`    missing ${entry}`);
  }

  if (missing(["SUPABASE_ACCESS_TOKEN"])) {
    console.log("  Create one in Supabase → Account → Access Tokens and add it as the repository secret SUPABASE_ACCESS_TOKEN.");
    if (task !== "report") fail("SUPABASE_ACCESS_TOKEN is needed for this task");
    return;
  }
  const headers = { Authorization: `Bearer ${env("SUPABASE_ACCESS_TOKEN")}`, "Content-Type": "application/json" };
  const api = `https://api.supabase.com/v1/projects/${ref}`;
  const sql = (query) => call(`${api}/database/query`, { method: "POST", headers, body: JSON.stringify({ query }) });

  const project = await call(api, { headers });
  if (!project.ok) return fail(`project: ${errorText(project)}`);
  console.log(`  "${project.body.name}" region=${project.body.region} status=${project.body.status}`);

  if (task !== "supabase-auth") {
    const history = await sql("select version from supabase_migrations.schema_migrations order by version");
    const applied = new Set(history.ok ? (history.body ?? []).map((row) => row.version) : []);
    const tables = await sql("select count(*)::int as n from pg_tables where schemaname = 'public'");
    const publicTables = tables.ok ? tables.body?.[0]?.n ?? 0 : null;
    const pending = localMigrations().filter((migration) => !applied.has(migration.version));
    console.log(`  migrations: ${applied.size} applied, ${pending.length} pending; public tables: ${publicTables ?? "unknown"}`);
    for (const migration of pending) console.log(`    pending ${migration.version}_${migration.name}`);

    if (task === "supabase-migrate" && apply && pending.length) {
      // A database with tables but no history was set up some other way: stop rather than guess.
      if (applied.size === 0 && publicTables) return fail("public has tables but no migration history; apply by hand after checking");
      const setup = await sql("create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text not null primary key, statements text[], name text)");
      if (!setup.ok) return fail(`migration history table: ${errorText(setup)}`);
      for (const migration of pending) {
        const body = readFileSync(migration.file, "utf8");
        const result = await sql(`begin;\n${body}\n;\ninsert into supabase_migrations.schema_migrations (version, name, statements) values (${quote(migration.version)}, ${quote(migration.name)}, array[${quote(body)}]);\ncommit;`);
        if (!result.ok) {
          fail(`${migration.version}_${migration.name}: ${errorText(result)} (its transaction rolled back; later migrations not attempted)`);
          return;
        }
        console.log(`    applied ${migration.version}_${migration.name}`);
      }
    }
  }

  if (task === "supabase-auth" || task === "report") {
    const auth = await call(`${api}/config/auth`, { headers });
    if (!auth.ok) return fail(`auth config: ${errorText(auth)}`);
    const current = auth.body;
    console.log(`  auth: site_url=${current.site_url} redirects=${current.uri_allow_list || "none"} confirmEmail=${!current.mailer_autoconfirm} smtp=${current.smtp_host || "Supabase default"} confirmSubject="${current.mailer_subjects_confirmation}"`);
    if (task !== "supabase-auth") return;

    const origin = siteOrigin();
    const patch = {
      site_url: origin,
      uri_allow_list: `${origin}/auth/confirm,${origin}/**`,
      external_email_enabled: true,
      mailer_autoconfirm: false,
      mfa_totp_enroll_enabled: true,
      mfa_totp_verify_enabled: true,
      mailer_subjects_confirmation: "Confirm your Autofix account",
      mailer_templates_confirmation_content: readFileSync("supabase/templates/confirmation.html", "utf8"),
      mailer_subjects_recovery: "Reset your Autofix admin password",
      mailer_templates_recovery_content: readFileSync("supabase/templates/recovery.html", "utf8"),
    };

    // Auth mail through Resend only once its domain is verified (a rejected sender would stop every login email).
    const domain = sendingDomain();
    const resendKey = env("RESEND_ADMIN_API_KEY") ?? env("RESEND_API_KEY");
    if (env("RESEND_API_KEY") && resendKey && domain) {
      const list = await call("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${resendKey}` } });
      const verified = list.ok && (list.body?.data ?? []).some((entry) => entry.name === domain && entry.status === "verified");
      if (verified) {
        Object.assign(patch, {
          smtp_admin_email: /<([^>]+)>/.exec(env("RESEND_FROM_EMAIL"))?.[1] ?? env("RESEND_FROM_EMAIL"),
          smtp_sender_name: "Autofix",
          smtp_host: "smtp.resend.com",
          smtp_port: "465",
          smtp_user: "resend",
          smtp_pass: env("RESEND_API_KEY"),
        });
        console.log(`  SMTP: Resend (${domain} is verified)`);
      } else {
        console.log(`  SMTP: left as is until ${domain} is verified in Resend`);
      }
    }

    if (!apply) {
      console.log(`  would set: ${Object.keys(patch).join(", ")}`);
      return;
    }
    const updated = await call(`${api}/config/auth`, { method: "PATCH", headers, body: JSON.stringify(patch) });
    if (updated.ok) console.log(`  auth updated: ${Object.keys(patch).filter((key) => key !== "smtp_pass").join(", ")}`);
    else fail(`auth update: ${errorText(updated)}`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Stripe, TEST MODE ONLY (P5.2 billing, P5.4 payments, P5.11 service plans; DECISIONS D17): the Pro and
// extra-site prices, the billing and Connect webhook endpoints, and their ids and signing secrets in
// Vercel production. BILLING_PROVIDER and PAYMENTS_PROVIDER are never set here: they are switched on later.
// ---------------------------------------------------------------------------------------------------------

// Monthly GBP prices, found again by lookup key. The amount is the plan setting (GitHub variable) or the
// price Temitope set on 29 Oct 2026. A fixed product id makes the product easy to find again.
const STRIPE_PRICES = [
  { product: "autofix_pro", name: "Autofix Pro", lookupKey: "autofix_pro_monthly", amountName: "PLAN_PRO_PRICE_PENCE", defaultPence: 4500, envName: "STRIPE_PRICE_PRO" },
  { product: "autofix_extra_site", name: "Autofix extra site", lookupKey: "autofix_extra_site_monthly", amountName: "PLAN_EXTRA_SITE_PRICE_PENCE", defaultPence: 1500, envName: "STRIPE_PRICE_EXTRA_SITE" },
];

// Exactly the events the handlers act on. Billing: src/lib/billing/stripe.ts (parseWebhook). Payments,
// a Connect endpoint: src/lib/payments/stripe.ts (mapStripePaymentsEvent) and, for service plans,
// src/lib/payments/stripe-direct-debit.ts (mapStripePlanEvent).
const STRIPE_ENDPOINTS = [
  {
    path: "/api/webhooks/billing/stripe",
    connect: false,
    description: "Autofix plans (billing)",
    secretName: "STRIPE_BILLING_WEBHOOK_SECRET",
    events: ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"],
  },
  {
    path: "/api/webhooks/payments/stripe",
    connect: true,
    description: "Autofix garage payments and service plans (Connect)",
    secretName: "STRIPE_PAYMENTS_WEBHOOK_SECRET",
    events: [
      "account.updated",
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "invoice.paid",
      "invoice.payment_failed",
    ],
  },
];

// Stripe's REST API over fetch, form-encoded (no SDK, as src/lib/billing/stripe.ts). `fields` is a list of
// [name, value] pairs, so an array field repeats its name.
function stripeApi(key) {
  const headers = { Authorization: `Bearer ${key}` };
  return {
    get: (pathAndQuery) => call(`https://api.stripe.com/v1${pathAndQuery}`, { headers }),
    post: (pathname, fields) =>
      call(`https://api.stripe.com/v1${pathname}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
      }),
  };
}

const pounds = (pence) => `£${(pence / 100).toFixed(2)} a month`;
const productionEntries = (envs, key) => envs.filter((entry) => entry.key === key && (entry.target ?? []).includes("production"));

/** Creates `key` for Production, or replaces the value of the entry that covers Production. Never prints the value. */
async function putProductionEnv({ project, team, headers }, envs, key, value, type) {
  const [entry] = productionEntries(envs, key);
  const result = entry
    ? await call(`https://api.vercel.com/v9/projects/${project}/env/${encodeURIComponent(entry.id)}?${team}`, { method: "PATCH", headers, body: JSON.stringify({ value, type }) })
    : await call(`https://api.vercel.com/v10/projects/${project}/env?${team}`, { method: "POST", headers, body: JSON.stringify({ key, value, type, target: ["production"] }) });
  if (!result.ok) return { ok: false, error: errorText(result) };
  console.log(`  ${key}: ${entry ? `replaced in Vercel (${(entry.target ?? []).join(", ")})` : "saved in Vercel production"} as ${type}`);
  return { ok: true };
}

/** The product's id, found or created; null after a FAIL line. */
async function stripeProduct(stripe, plan) {
  const byId = await stripe.get(`/products/${plan.product}`);
  if (byId.ok) return byId.body.id;
  if (byId.status !== 404) {
    fail(`product "${plan.name}": ${errorText(byId)}`);
    return null;
  }
  // One made by hand under the same name is used rather than a second one.
  const list = await stripe.get(`/products?${new URLSearchParams({ active: "true", limit: "100" })}`);
  if (!list.ok) {
    fail(`products: ${errorText(list)}`);
    return null;
  }
  const named = (list.body?.data ?? []).find((product) => product.name === plan.name);
  if (named) {
    console.log(`  product "${plan.name}": found`);
    return named.id;
  }
  const created = await stripe.post("/products", [["id", plan.product], ["name", plan.name], ["metadata[app]", "autofix"]]);
  if (!created.ok) {
    fail(`product "${plan.name}": create failed, ${errorText(created)}`);
    return null;
  }
  console.log(`  product "${plan.name}": created`);
  return created.body.id;
}

/** The plan's monthly amount in pence; null when its variable is not a whole number of pence. */
function planPence(plan) {
  const raw = env(plan.amountName);
  if (raw === null) return plan.defaultPence;
  return /^[1-9]\d{0,6}$/.test(raw) ? Number(raw) : null;
}

/** The price id for this plan, found by lookup key or (apply) created; null when there is none to use. */
async function stripePrice(stripe, plan) {
  const amount = planPence(plan);
  const found = await stripe.get(`/prices?${new URLSearchParams({ "lookup_keys[]": plan.lookupKey, limit: "1" })}`);
  if (!found.ok) {
    fail(`${plan.lookupKey}: ${errorText(found)}`);
    return null;
  }
  const price = found.body?.data?.[0];
  if (price) {
    const monthly = price.recurring?.interval === "month" && (price.recurring?.interval_count ?? 1) === 1;
    if (price.unit_amount !== amount || price.currency !== "gbp" || !monthly) {
      // A price's amount can't be changed in Stripe; whether to move the lookup key to a new price is a decision.
      const has = `unit_amount ${price.unit_amount} ${String(price.currency).toUpperCase()} ${price.recurring ? `every ${price.recurring.interval_count ?? 1} ${price.recurring.interval}` : "one-off"}`;
      fail(`${plan.lookupKey}: exists at ${has}, not unit_amount ${amount} GBP every 1 month; left unchanged`);
      return null;
    }
    if (!price.active) {
      fail(`${plan.lookupKey}: exists but is archived in Stripe; left unchanged`);
      return null;
    }
    console.log(`  ${plan.lookupKey}: exists (${pounds(amount)}, active)`);
    return price.id;
  }
  if (!apply) {
    console.log(`  ${plan.lookupKey}: missing (would create "${plan.name}" at ${pounds(amount)})`);
    return null;
  }
  const product = await stripeProduct(stripe, plan);
  if (!product) return null;
  const created = await stripe.post("/prices", [
    ["product", product],
    ["currency", "gbp"],
    ["unit_amount", String(amount)],
    ["recurring[interval]", "month"],
    ["lookup_key", plan.lookupKey],
    ["nickname", `${plan.name} monthly`],
    ["metadata[app]", "autofix"],
  ]);
  if (!created.ok) {
    fail(`${plan.lookupKey}: create failed, ${errorText(created)}`);
    return null;
  }
  console.log(`  ${plan.lookupKey}: created (${pounds(amount)})`);
  return created.body.id;
}

/** Puts the price id in Vercel production when it is missing there; true when production changed. */
async function stripePriceEnv(vercel, envs, plan, priceId) {
  const [entry] = productionEntries(envs, plan.envName);
  if (!entry) {
    if (!apply || !priceId) {
      console.log(`  ${plan.envName}: not in Vercel production (${apply ? "no price to point at" : "would set"})`);
      return false;
    }
    const saved = await putProductionEnv(vercel, envs, plan.envName, priceId, "encrypted");
    if (!saved.ok) fail(`${plan.envName}: Vercel ${saved.error}`);
    return saved.ok;
  }
  // A sensitive value can't be read back, so it can't be compared.
  if (!priceId || entry.type === "sensitive") {
    console.log(`  ${plan.envName}: set in Vercel production${priceId ? " (sensitive, not compared)" : ""}`);
    return false;
  }
  const { project, team, headers } = vercel;
  const read = await call(`https://api.vercel.com/v1/projects/${project}/env/${encodeURIComponent(entry.id)}?${team}`, { headers });
  if (!read.ok) fail(`${plan.envName}: Vercel ${errorText(read)}`);
  else if (read.body?.value === priceId) console.log(`  ${plan.envName}: set in Vercel production (the ${plan.lookupKey} price)`);
  else fail(`${plan.envName}: Vercel production points at a different price than ${plan.lookupKey}; left unchanged (correct it in GitHub and run Sync Vercel env, or delete it in Vercel and run stripe-setup again)`);
  return false;
}

/** Every webhook endpoint on the account; null after a FAIL line. */
async function stripeEndpoints(stripe) {
  const all = [];
  let after = null;
  for (let page = 0; page < 10; page += 1) {
    const result = await stripe.get(`/webhook_endpoints?${new URLSearchParams({ limit: "100", ...(after ? { starting_after: after } : {}) })}`);
    if (!result.ok) {
      fail(`webhook endpoints: ${errorText(result)}`);
      return null;
    }
    const data = result.body?.data ?? [];
    all.push(...data);
    if (!result.body?.has_more || !data.length) break;
    after = data[data.length - 1].id;
  }
  return all;
}

/** Finds or (apply) creates one endpoint and saves a new signing secret in Vercel; true when production changed. */
async function stripeEndpoint(stripe, vercel, envs, endpoints, spec) {
  const url = `${siteOrigin()}${spec.path}`;
  const label = `${spec.connect ? "Connect" : "account"} webhook ${spec.path}`;
  // The API doesn't say whether an endpoint is a Connect one, so the URL (one path per endpoint) finds it.
  const found = endpoints.find((endpoint) => endpoint.url === url);
  if (found) {
    const enabled = found.enabled_events ?? [];
    const absent = enabled.includes("*") ? [] : spec.events.filter((event) => !enabled.includes(event));
    console.log(`  ${label}: exists, ${found.status}${absent.length ? `, missing events ${absent.join(", ")}${apply ? "" : " (would add)"}` : ", every event enabled"}`);
    if (found.status !== "enabled") fail(`${label} is ${found.status} in Stripe; enable it there`);
    if (absent.length && apply) {
      // Adding events keeps the signing secret; events already enabled stay enabled.
      const events = [...new Set([...enabled, ...spec.events])];
      const updated = await stripe.post(`/webhook_endpoints/${encodeURIComponent(found.id)}`, events.map((event) => ["enabled_events[]", event]));
      if (updated.ok) console.log(`    events added: ${absent.join(", ")}`);
      else fail(`${label}: adding events failed, ${errorText(updated)}`);
    }
    if (!vercel) return false;
    if (productionEntries(envs, spec.secretName).length) {
      console.log(`    ${spec.secretName}: set in Vercel production`);
    } else {
      // Stripe's API returns a signing secret only when the endpoint is made. Never delete or roll it here.
      fail(
        `${spec.secretName} is not in Vercel production, and the API only returns a signing secret when an endpoint is created; the endpoint was left as it is. ` +
          `Either reveal its signing secret in Stripe (test mode) > Developers > Webhooks > ${url}, save it as the GitHub secret ${spec.secretName} and run Sync Vercel env; ` +
          "or delete that endpoint in Stripe and run stripe-setup again.",
      );
    }
    return false;
  }
  if (!apply) {
    console.log(`  ${label}: missing (would create with ${spec.events.length} events and save ${spec.secretName} in Vercel production)`);
    return false;
  }
  const created = await stripe.post("/webhook_endpoints", [
    ["url", url],
    ["description", spec.description],
    ["metadata[app]", "autofix"],
    ...(spec.connect ? [["connect", "true"]] : []),
    ...spec.events.map((event) => ["enabled_events[]", event]),
  ]);
  if (!created.ok) {
    fail(`${label}: create failed, ${errorText(created)}`);
    return false;
  }
  console.log(`  ${label}: created with ${spec.events.length} events`);
  const secret = created.body?.secret;
  const saved = typeof secret === "string" && secret.startsWith("whsec_") ? await putProductionEnv(vercel, envs, spec.secretName, secret, "sensitive") : { ok: false, error: "Stripe returned no signing secret" };
  if (!saved.ok) {
    fail(
      `${spec.secretName}: not saved in Vercel (${saved.error}). Reveal the new endpoint's signing secret in Stripe (test mode) > Developers > Webhooks > ${url}, ` +
        `save it as the GitHub secret ${spec.secretName} and run Sync Vercel env; or delete that endpoint in Stripe and run stripe-setup again.`,
    );
  }
  return saved.ok;
}

// Read only: whether Connect answers in test mode. Never creates a connected account.
async function stripeConnect(stripe) {
  const accounts = await stripe.get("/accounts?limit=1");
  if (accounts.ok) return console.log(`  Connect: enabled in test mode (${accounts.body?.data?.length ? "has connected accounts" : "no connected accounts yet"})`);
  const message = accounts.body?.error?.message ?? "";
  if (/connect/i.test(message)) return console.log(`  Connect: does not look enabled in test mode (Stripe says: ${message})`);
  console.log(`  Connect: could not tell (${errorText(accounts)})`);
}

async function stripeSetup() {
  heading("Stripe (test mode)");
  if (missing(["STRIPE_SECRET_KEY"])) return fail("Stripe is not configured");
  // Test mode only, as the app (src/lib/billing/index.ts) and sync-vercel-env.mjs: a live key is never used.
  if (!/^(sk|rk)_test_/.test(env("STRIPE_SECRET_KEY"))) {
    return fail("STRIPE_SECRET_KEY is not a test-mode key (sk_test_ or rk_test_); live keys are refused, so nothing was read or changed");
  }
  const badAmounts = STRIPE_PRICES.filter((plan) => planPence(plan) === null).map((plan) => plan.amountName);
  if (badAmounts.length) return fail(`${badAmounts.join(", ")} must be a whole number of pence; nothing was read or changed`);
  const stripe = stripeApi(env("STRIPE_SECRET_KEY"));

  // A new endpoint's signing secret goes straight to Vercel: without Vercel, nothing is created.
  let vercel = null;
  let envs = [];
  if (missing(["VERCEL_API_TOKEN", "VERCEL_PROJECT_ID", "VERCEL_TEAM_ID"])) {
    if (apply) return fail("Vercel is not configured; nothing was created in Stripe");
  } else {
    const api = vercelApi();
    const listed = await vercelEnvs(api);
    if (listed.list.ok) {
      vercel = api;
      envs = listed.envs;
    } else {
      fail(`Vercel env list: ${errorText(listed.list)}`);
      if (apply) return console.log("  nothing was created in Stripe");
    }
  }

  await stripeConnect(stripe);

  let productionChanged = false;
  for (const plan of STRIPE_PRICES) {
    const priceId = await stripePrice(stripe, plan);
    if (vercel && (await stripePriceEnv(vercel, envs, plan, priceId))) productionChanged = true;
  }
  const endpoints = await stripeEndpoints(stripe);
  if (endpoints) {
    for (const spec of STRIPE_ENDPOINTS) {
      if (await stripeEndpoint(stripe, vercel, envs, endpoints, spec)) productionChanged = true;
    }
  }
  console.log("  BILLING_PROVIDER, PAYMENTS_PROVIDER: not changed here (they are switched on separately)");
  if (productionChanged) await redeployProduction(vercel, "production redeployed with the Stripe settings");
}

// ---------------------------------------------------------------------------------------------------------

const run = {
  report: async () => {
    keysLine();
    await vercelDomains();
    await vercelSecrets();
    await twilioWebhooks();
    await resendDomain();
    await supabase();
    await stripeSetup();
  },
  "vercel-domains": vercelDomains,
  "vercel-secrets": vercelSecrets,
  "twilio-webhooks": twilioWebhooks,
  "resend-domain": resendDomain,
  "supabase-migrate": supabase,
  "supabase-auth": supabase,
  "stripe-setup": stripeSetup,
};

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  try {
    await run[task]();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  console.log(`\n${failures ? `${failures} problem(s)` : "done"}${apply ? "" : " (nothing was changed)"}`);
  // A report informs (its problems are the FAIL lines above); only a run that was meant to change something fails.
  if (failures && apply) process.exit(1);
}
