#!/usr/bin/env node
// Runs Lighthouse CI on booking routes with the Askbridge widget on (P4.6). See lighthouserc.askbridge.cjs.
// Uses the local Supabase service key (`supabase status`) only to flip hartley-road's chat setting.
import { execFileSync, spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const status = Object.fromEntries(
  execFileSync("pnpm", ["exec", "supabase", "status", "-o", "env"], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.match(/^([A-Z_]+)="?(.*?)"?$/))
    .filter(Boolean)
    .map((match) => [match[1], match[2]]),
);
const db = createClient(status.API_URL, status.SECRET_KEY, { auth: { persistSession: false } });
const { data: garage, error } = await db.from("garages").select("id, settings").eq("slug", "hartley-road").single();
if (error || !garage) throw new Error("Seed the demo garages first (pnpm db:seed).");
const original = garage.settings ?? {};

const stub = spawn(process.execPath, ["scripts/askbridge-widget-stub.mjs"], { stdio: "inherit" });
let code = 1;
try {
  await db.from("garages").update({ settings: { ...original, askbridge: { enabled: true, widgetId: "wid_lighthouse" } } }).eq("id", garage.id);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const run = spawn("pnpm", ["exec", "lhci", "autorun", "--config=lighthouserc.askbridge.cjs"], { stdio: "inherit", env: process.env });
  code = await new Promise((resolve) => run.on("exit", (exitCode) => resolve(exitCode ?? 1)));
} finally {
  await db.from("garages").update({ settings: original }).eq("id", garage.id);
  stub.kill();
}
process.exit(code);
