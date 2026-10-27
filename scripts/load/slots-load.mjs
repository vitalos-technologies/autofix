#!/usr/bin/env node
/**
 * Load test for `GET /api/slots` on a garage booking host (P4.7).
 *
 * Open model: requests start on a fixed schedule (--rps for --duration seconds) whether or not
 * earlier ones have answered, so a slow server shows up as latency, not as a lower request rate.
 * `--queries narrow` (default): each request asks for one of the garage's online services and a
 * 14-day window starting on one of the next 14 days, the mix a busy booking page sends (the 30 s
 * per-instance slot cache answers most of it). `--queries wide`: start days up to 59 days ahead and
 * windows of 1 to 14 days, so nearly every request misses the cache and runs `available_slots()`.
 * Requests are spread over 508 documentation-range client addresses (RFC 5737) in
 * `x-forwarded-for`, so the per-IP rate limit (30 per 5 minutes) is exercised but never hit.
 *
 *   node scripts/load/slots-load.mjs --origin http://127.0.0.1:3000 --host hartley-road.localhost:3000
 *
 * Options: --origin (where to connect), --host (Host header: the garage host; default the origin's),
 * --rps 50, --duration 60, --warmup 5 (seconds, not counted), --p95 300 (ms budget),
 * --max-errors 0.01 (share of non-200 answers allowed), --queries narrow|wide, --out output/load.
 * Writes `<out>/slots-<timestamp>.json` and `.md`; exits 1 when p95 or the error budget is missed.
 */
import http from "node:http";
import https from "node:https";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULTS = { origin: "http://127.0.0.1:3000", host: "", rps: 50, duration: 60, warmup: 5, p95: 300, "max-errors": 0.01, out: "output/load", queries: "narrow" };

export function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue; // `pnpm test:load -- --rps 10`
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const [name, inline] = arg.slice(2).split("=", 2);
    if (!(name in DEFAULTS)) throw new Error(`Unknown option --${name}`);
    const value = inline ?? argv[(index += 1)];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    options[name] = typeof DEFAULTS[name] === "number" ? Number(value) : value;
    if (typeof DEFAULTS[name] === "number" && !Number.isFinite(options[name])) throw new Error(`--${name} must be a number`);
  }
  if (!["narrow", "wide"].includes(options.queries)) throw new Error("--queries must be narrow or wide");
  const origin = new URL(options.origin);
  return { ...options, origin, host: options.host || origin.host };
}

/** Nearest-rank percentile of an ascending list. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function summarise(samples, { p95Budget, maxErrorShare }) {
  const latencies = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  const statuses = {};
  for (const sample of samples) statuses[sample.status] = (statuses[sample.status] ?? 0) + 1;
  const ok = statuses[200] ?? 0;
  const errorShare = samples.length ? (samples.length - ok) / samples.length : 1;
  const result = {
    requests: samples.length,
    statuses,
    errorShare,
    latencyMs: {
      min: latencies[0] ?? null,
      p50: percentile(latencies, 50),
      p90: percentile(latencies, 90),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies.at(-1) ?? null,
      mean: latencies.length ? Math.round((latencies.reduce((sum, ms) => sum + ms, 0) / latencies.length) * 10) / 10 : null,
    },
  };
  return { ...result, passed: samples.length > 0 && result.latencyMs.p95 < p95Budget && errorShare <= maxErrorShare };
}

/** 508 client addresses from TEST-NET-2 and TEST-NET-3. */
export function clientAddresses() {
  const addresses = [];
  for (const prefix of ["198.51.100", "203.0.113"]) for (let last = 1; last <= 254; last += 1) addresses.push(`${prefix}.${last}`);
  return addresses;
}

function localDateKey(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function addDays(key, days) {
  const date = new Date(`${key}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function request(options, agent, pathAndQuery, clientIp) {
  const client = options.origin.protocol === "https:" ? https : http;
  const started = process.hrtime.bigint();
  return new Promise((resolve) => {
    const req = client.request(
      {
        protocol: options.origin.protocol,
        hostname: options.origin.hostname,
        port: options.origin.port || (options.origin.protocol === "https:" ? 443 : 80),
        path: pathAndQuery,
        method: "GET",
        agent,
        headers: { host: options.host, accept: "application/json", "x-forwarded-for": clientIp, "user-agent": "autofix-load-test" },
        timeout: 10_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, ms: Number(process.hrtime.bigint() - started) / 1e6, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve({ status: 0, ms: Number(process.hrtime.bigint() - started) / 1e6, body: "" }));
    req.end();
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const agent = new (options.origin.protocol === "https:" ? https : http).Agent({ keepAlive: true, maxSockets: 256 });
  const addresses = clientAddresses();

  const services = await request(options, agent, "/api/services", addresses[0]);
  if (services.status !== 200) throw new Error(`GET /api/services answered ${services.status}; is ${options.host} a garage host with seeded services?`);
  const parsed = JSON.parse(services.body);
  const serviceIds = (parsed.services ?? []).map((service) => service.id).filter(Boolean);
  if (serviceIds.length === 0) throw new Error("The garage has no online services to ask about.");
  const timeZone = parsed.timezone ?? "Europe/London";
  const today = localDateKey(new Date(), timeZone);
  const queries = [];
  const startDays = options.queries === "wide" ? 60 : 14;
  const windows = options.queries === "wide" ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] : [14];
  for (const days of windows) {
    for (let offset = 0; offset < startDays; offset += 1) {
      for (const service of serviceIds) {
        const from = addDays(today, offset);
        queries.push(`/api/slots?service=${service}&from=${from}&to=${addDays(from, days - 1)}`);
      }
    }
  }

  const total = Math.round(options.rps * (options.warmup + options.duration));
  const warmupCount = Math.round(options.rps * options.warmup);
  const interval = 1000 / options.rps;
  const samples = [];
  const pending = [];
  const startedAt = new Date();
  const t0 = performance.now();
  for (let index = 0; index < total; index += 1) {
    const due = t0 + index * interval;
    const wait = due - performance.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const query = queries[index % queries.length];
    const ip = addresses[index % addresses.length];
    pending.push(request(options, agent, query, ip).then((result) => {
      if (index >= warmupCount) samples.push({ status: result.status, ms: Math.round(result.ms * 10) / 10 });
    }));
  }
  await Promise.all(pending);
  const elapsed = (performance.now() - t0) / 1000;
  agent.destroy();

  const summary = summarise(samples, { p95Budget: options.p95, maxErrorShare: options["max-errors"] });
  const report = {
    endpoint: "GET /api/slots",
    host: options.host,
    origin: options.origin.origin,
    startedAt: startedAt.toISOString(),
    queries: options.queries,
    targetRps: options.rps,
    durationSeconds: options.duration,
    warmupSeconds: options.warmup,
    achievedRps: Math.round((total / elapsed) * 10) / 10,
    services: serviceIds.length,
    distinctQueries: queries.length,
    clientAddresses: addresses.length,
    budget: { p95Ms: options.p95, maxErrorShare: options["max-errors"] },
    ...summary,
  };

  mkdirSync(options.out, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const base = path.join(options.out, `slots-${options.queries}-${stamp}`);
  writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  const l = report.latencyMs;
  writeFileSync(`${base}.md`, [
    `# Slots load test, ${report.startedAt}`,
    "",
    `\`GET /api/slots\` on \`${report.host}\` via ${report.origin}: ${report.targetRps} rps for ${report.durationSeconds} s (after ${report.warmupSeconds} s warm-up), achieved ${report.achievedRps} rps; \`--queries ${report.queries}\`: ${report.distinctQueries} distinct queries over ${report.services} services, ${report.clientAddresses} client addresses.`,
    "",
    "| Requests | 200 | Other | p50 | p90 | p95 | p99 | max | Budget | Result |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    `| ${report.requests} | ${report.statuses[200] ?? 0} | ${report.requests - (report.statuses[200] ?? 0)} | ${l.p50} ms | ${l.p90} ms | ${l.p95} ms | ${l.p99} ms | ${l.max} ms | p95 < ${options.p95} ms, errors ≤ ${options["max-errors"] * 100}% | ${report.passed ? "pass" : "FAIL"} |`,
    "",
    `Statuses: ${Object.entries(report.statuses).map(([status, count]) => `${status} × ${count}`).join(", ")}.`,
    "",
  ].join("\n"));

  console.log(`slots load: ${report.requests} requests, p50 ${l.p50} ms, p95 ${l.p95} ms, p99 ${l.p99} ms, errors ${(report.errorShare * 100).toFixed(2)}% -> ${report.passed ? "pass" : "FAIL"} (${base}.md)`);
  if (!report.passed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`slots load: ${error.message}`);
    process.exitCode = 1;
  });
}
