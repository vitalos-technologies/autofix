// Gate 4 launch steps (docs/autofix/LAUNCH.md), run from GitHub Actions with the repository's secrets and
// variables (.github/workflows/launch-ops.yml), so nobody pastes a key into a chat or a terminal.
//
//   LAUNCH_TASK   report | vercel-domains | twilio-webhooks | resend-domain | supabase-migrate | supabase-auth
//   LAUNCH_APPLY  "true" to change anything; otherwise every task only reports what it would do.
//
// Prints names, statuses, hosts and public DNS records only: never a secret value. Phone numbers are
// shown by their last four digits.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const TASKS = ["report", "vercel-domains", "twilio-webhooks", "resend-domain", "supabase-migrate", "supabase-auth"];
// Cloudflare zone of vitalos.co.uk (docs/autofix/INFRA.md); CLOUDFLARE_ZONE_ID overrides it.
const DEFAULT_ZONE_ID = "99115a2bb8d6630faff3cb8151e1f35c";
const MIGRATIONS_DIR = "supabase/migrations";

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
  if (missing(["RESEND_API_KEY", "RESEND_FROM_EMAIL"])) return fail("Resend is not configured");
  const domain = sendingDomain();
  if (!domain) return fail("RESEND_FROM_EMAIL has no domain");
  const headers = { Authorization: `Bearer ${env("RESEND_API_KEY")}`, "Content-Type": "application/json" };

  const list = await call("https://api.resend.com/domains", { headers });
  if (!list.ok) return fail(`Resend domains: ${errorText(list)}`);
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

  // Without a Management API token, the service key can still say whether the schema exists.
  const secretKey = env("SUPABASE_SECRET_KEY");
  if (secretKey) {
    const probe = await call(`https://${ref}.supabase.co/rest/v1/garages?select=id&limit=1`, { headers: { apikey: secretKey, Authorization: `Bearer ${secretKey}` } });
    console.log(`  public.garages: ${probe.ok ? `exists (${(probe.body ?? []).length ? "has rows" : "empty"})` : `not reachable (${errorText(probe)})`}`);
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
    if (env("RESEND_API_KEY") && domain) {
      const list = await call("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}` } });
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

const run = {
  report: async () => {
    await vercelDomains();
    await twilioWebhooks();
    await resendDomain();
    await supabase();
  },
  "vercel-domains": vercelDomains,
  "twilio-webhooks": twilioWebhooks,
  "resend-domain": resendDomain,
  "supabase-migrate": supabase,
  "supabase-auth": supabase,
};

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  try {
    await run[task]();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  console.log(`\n${failures ? `${failures} problem(s)` : "done"}${apply ? "" : " (nothing was changed)"}`);
  if (failures) process.exit(1);
}
