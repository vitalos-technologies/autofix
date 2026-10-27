#!/usr/bin/env node
/**
 * Local demo data for Autofix (P1.9): `pnpm db:seed`.
 *
 * LOCAL ONLY. The script refuses any Supabase URL that is not a local CLI
 * stack (plain http on a loopback host; any port, since CI runners shift
 * ports per runner), the same rule as tests/helpers/local-supabase.ts. It
 * never talks to a hosted project.
 *
 * Idempotent: every row has a fixed UUID derived from a stable name and is
 * written with an upsert, so running it twice leaves one copy of everything
 * (and repairs rows you changed by hand).
 *
 * What it creates
 *   - Garage A "Hartley Road Motors" (hartley-road, HRM, accent #155fba, MOT on)
 *     and garage B "Demo Garage B" (demo-b, DGB, accent #0f766e, MOT off).
 *   - Staff users through the Auth admin API: A owner, A manager, A technician,
 *     B owner, and one user who is a manager in both garages.
 *   - site_settings rows, sample customers and vehicles (fictional names, UK
 *     mobiles in Ofcom's 07700 900xxx drama range) and a few enquiries.
 *   - Scheduling data (P2.1): 3 bays + 1 mobile van, opening hours
 *     (Mon-Fri 08:00-17:30, Sat 08:30-13:00), closures and six services per
 *     garage; the MOT service only at hartley-road (MOT on).
 *
 * Environment
 *   Supabase URL and secret key, first match wins:
 *     INTEGRATION_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_URL, API_URL, SUPABASE_URL
 *     INTEGRATION_SUPABASE_SECRET_KEY, SUPABASE_SECRET_KEY, SECRET_KEY, SERVICE_ROLE_KEY
 *   With none set, the script reads `supabase status -o env` from the local CLI.
 *
 *   SEED_STAFF_PASSWORD  Password for every demo staff user. Default:
 *                        "Autofix-demo-local-1" (local only; never reuse it).
 *                        The script prints emails, never passwords.
 *   SEED_RELAX_MFA=1     LOCAL CONVENIENCE ONLY. Turns mandatory MFA for owners
 *                        OFF in admin_mfa_policy so owners can sign in without
 *                        enrolling TOTP (DECISIONS.md A15). Without it the seed
 *                        restores the shipped default (mandatory MFA on) and
 *                        owners enrol TOTP at /app/mfa/enroll on first sign-in.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const DEFAULT_STAFF_PASSWORD = "Autofix-demo-local-1";
const SEED_NAMESPACE = "5eed0000-a0f1-4c00-8000-0000000a0f1c";

// ---------------------------------------------------------------------------
// Demo data
// ---------------------------------------------------------------------------

const GARAGES = [
  {
    key: "a",
    slug: "hartley-road",
    name: "Hartley Road Motors",
    legal_name: "Hartley Road Motors Ltd",
    booking_prefix: "HRM",
    accent: "#155fba",
    mot_enabled: true,
    phone: "+441302000000",
    whatsapp: "+447700900001",
    email: "hello@hartley-road.example",
    address: { line1: "14 Hartley Road", line2: "Balby", town: "Doncaster", postcode: "DN4 8AB" },
    service_area: ["DN1", "DN2", "DN3", "DN4", "DN5", "DN6", "DN11", "DN12"],
    sms_sender: "HartleyRd",
    plan: "growth",
    settings: { tagline: "Independent garage, Doncaster" },
  },
  {
    key: "b",
    slug: "demo-b",
    name: "Demo Garage B",
    legal_name: "Demo Garage B Ltd",
    booking_prefix: "DGB",
    accent: "#0f766e",
    mot_enabled: false,
    phone: "+441632960000",
    whatsapp: null,
    email: "hello@demo-b.example",
    address: { line1: "2 Example Street", line2: null, town: "Rotherham", postcode: "S60 1AA" },
    service_area: ["S60", "S61", "S65", "S66"],
    sms_sender: "DemoGarageB",
    plan: "trial",
    settings: { tagline: "Demo data for tenancy checks" },
  },
];

const STAFF = [
  { email: "owner@hartley-road.example", displayName: "Sam Hartley", memberships: [["a", "owner"]] },
  { email: "manager@hartley-road.example", displayName: "Priya Shah", memberships: [["a", "manager"]] },
  { email: "technician@hartley-road.example", displayName: "Dan Cole", memberships: [["a", "technician"]] },
  { email: "owner@demo-b.example", displayName: "Morgan Reid", memberships: [["b", "owner"]] },
  { email: "shared.manager@autofix-demo.example", displayName: "Alex Morgan", memberships: [["a", "manager"], ["b", "manager"]] },
];

// [name, mobile, preferred contact, vehicles: [registration, make, model, year, colour, fuel]]
const CUSTOMERS = {
  a: [
    ["Olivia Bennett", "+447700900101", "phone", [["YD19 KXT", "Ford", "Focus", 2019, "Blue", "Petrol"]]],
    ["Harry Whitaker", "+447700900102", "whatsapp", [["YE68 PLM", "Vauxhall", "Corsa", 2018, "Red", "Petrol"]]],
    ["Amelia Price", "+447700900103", "email", [["YB21 HRT", "Nissan", "Qashqai", 2021, "Grey", "Diesel"]]],
    ["Jack Holloway", "+447700900104", "phone", [["YK17 WDF", "Volkswagen", "Golf", 2017, "White", "Petrol"]]],
    ["Isla Fenwick", "+447700900105", "whatsapp", [["YG70 MNA", "Toyota", "Yaris", 2020, "Silver", "Hybrid"]]],
    ["George Ashworth", "+447700900106", "phone", [["YT16 RZV", "BMW", "320d", 2016, "Black", "Diesel"]]],
    ["Sophie Marsh", "+447700900107", "email", [["YC22 LBN", "Kia", "Sportage", 2022, "Grey", "Hybrid"]]],
    ["Thomas Driscoll", "+447700900108", "phone", [["YJ69 FZK", "Ford", "Transit Custom", 2019, "White", "Diesel"]]],
    ["Grace Lindqvist", "+447700900109", "whatsapp", [["YH15 OPA", "Honda", "Jazz", 2015, "Blue", "Petrol"]]],
    ["Noah Pemberton", "+447700900110", "phone", [
      ["YA20 DCE", "Skoda", "Octavia", 2020, "Green", "Diesel"],
      ["YP14 ZZT", "Fiat", "500", 2014, "White", "Petrol"],
    ]],
  ],
  b: [
    ["Ruby Calloway", "+447700900201", "phone", [["MA19 KVE", "Peugeot", "208", 2019, "Yellow", "Petrol"]]],
    ["Oscar Thorne", "+447700900202", "email", [["MD67 PWS", "Renault", "Clio", 2017, "Red", "Petrol"]]],
    ["Freya Galloway", "+447700900203", "whatsapp", [["ML21 XGB", "Hyundai", "Tucson", 2021, "Blue", "Hybrid"]]],
    ["Leo Ramsden", "+447700900204", "phone", [["MF18 NHA", "MINI", "Cooper", 2018, "Green", "Petrol"]]],
    ["Ava Kingsley", "+447700900205", "email", [["MK70 OYR", "Audi", "A3", 2020, "Grey", "Diesel"]]],
    ["Arthur Pryce", "+447700900206", "phone", [["MJ16 UDL", "Mercedes-Benz", "A-Class", 2016, "Black", "Diesel"]]],
    ["Mia Hartnell", "+447700900207", "whatsapp", [["MT22 EVR", "Tesla", "Model 3", 2022, "White", "Electric"]]],
    ["Henry Oakes", "+447700900208", "phone", [["MW15 CXP", "Dacia", "Sandero", 2015, "Blue", "Petrol"]]],
  ],
};

// [customer name, enquiry type, status, description, postcode, driveable]
const ENQUIRIES = {
  a: [
    ["Olivia Bennett", "diagnostic", "new", "Engine management light came on after a cold start and the car feels down on power.", null, true],
    ["Jack Holloway", "repair", "contacted", "Grinding noise from the front brakes when stopping at low speed.", null, true],
    ["Thomas Driscoll", "mobile", "new", "Van will not start at our yard this morning; the battery seems flat.", "DN2 4PY", false],
  ],
  b: [
    ["Ruby Calloway", "general", "new", "Do you re-gas air conditioning, and roughly what does it cost?", null, true],
    ["Arthur Pryce", "inspection", "contacted", "Looking for a pre-purchase inspection on a used car next week.", null, true],
  ],
};

// Scheduling (tables from P2.1, docs/autofix/ARCHITECTURE.md "Booking engine").
const RESOURCES = [
  { name: "Bay 1", kind: "bay", sort: 1 },
  { name: "Bay 2", kind: "bay", sort: 2 },
  { name: "Bay 3", kind: "bay", sort: 3 },
  { name: "Mobile van", kind: "mobile", sort: 4 },
];

// ISO weekday (1 = Monday). Sunday closed.
const OPENING_HOURS = [
  ...[1, 2, 3, 4, 5].map((weekday) => ({ weekday, opens: "08:00", closes: "17:30" })),
  { weekday: 6, opens: "08:30", closes: "13:00" },
];

const CLOSURES = [
  { starts_on: "2026-12-25", ends_on: "2026-12-28", reason: "Christmas" },
  { starts_on: "2027-01-01", ends_on: "2027-01-01", reason: "New Year's Day" },
];

// Six services; MOT only where the garage has MOT enabled (garage A).
const SERVICES = [
  {
    key: "mot", name: "MOT", description: "MOT test for cars and light vans (class 4).",
    duration_min: 60, buffer_min: 0, price_pence: 5485, price_mode: "fixed", location_mode: "workshop",
    resource_kind: "bay", needs_approval: false, is_mot: true,
  },
  {
    key: "diagnostics", name: "Diagnostics", description: "Warning lights, running faults and electrical problems traced and explained.",
    duration_min: 60, buffer_min: 15, price_pence: 4500, price_mode: "from", location_mode: "both",
    resource_kind: "bay", needs_approval: false, is_mot: false,
  },
  {
    key: "full-service", name: "Full service", description: "Annual service: oil and filters, fluids, brakes, steering and suspension checks.",
    duration_min: 180, buffer_min: 15, price_pence: 17900, price_mode: "from", location_mode: "workshop",
    resource_kind: "bay", needs_approval: false, is_mot: false,
  },
  {
    key: "interim-service", name: "Interim service", description: "Six-monthly oil and filter change with safety checks.",
    duration_min: 90, buffer_min: 15, price_pence: 11900, price_mode: "from", location_mode: "workshop",
    resource_kind: "bay", needs_approval: false, is_mot: false,
  },
  {
    key: "brakes", name: "Brakes", description: "Pads, discs and brake fluid. We inspect first and quote before any work.",
    duration_min: 90, buffer_min: 15, price_pence: null, price_mode: "quote", location_mode: "workshop",
    resource_kind: "bay", needs_approval: true, is_mot: false,
  },
  {
    key: "something-else", name: "Something else", description: "Tell us what is wrong and we will call you with a quote.",
    duration_min: 60, buffer_min: 0, price_pence: null, price_mode: "quote", location_mode: "both",
    resource_kind: "bay", needs_approval: true, is_mot: false,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic UUID (version 5 layout) for a stable seed name. */
function seedUuid(name) {
  const hash = createHash("sha1")
    .update(Buffer.from(SEED_NAMESPACE.replaceAll("-", ""), "hex"))
    .update(name)
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function firstEnv(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

function readLocalCliStatus() {
  const localBinary = resolve("node_modules/.bin/supabase");
  const binary = existsSync(localBinary) ? localBinary : "supabase";
  let output;
  try {
    output = execFileSync(binary, ["status", "-o", "env"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 });
  } catch {
    throw new Error("Supabase env is not set and `supabase status` failed. Start the local stack with `pnpm exec supabase start`.");
  }
  const values = {};
  for (const line of output.split("\n")) {
    const match = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

/** Local Supabase only: plain http on a loopback host, any port (tests/helpers/local-supabase.ts). */
function assertLocalSupabaseUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Refusing to seed: the Supabase URL is not a valid URL.");
  }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
  if (!loopback || parsed.protocol !== "http:") {
    throw new Error(`Refusing to seed non-local Supabase URL ${parsed.origin}. The demo seed only runs against a local CLI stack (http on 127.0.0.1, localhost or [::1]).`);
  }
  return parsed.origin;
}

function resolveSupabase() {
  let url = firstEnv("INTEGRATION_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "API_URL", "SUPABASE_URL");
  let secretKey = firstEnv("INTEGRATION_SUPABASE_SECRET_KEY", "SUPABASE_SECRET_KEY", "SECRET_KEY", "SERVICE_ROLE_KEY");
  if (!url || !secretKey) {
    const status = readLocalCliStatus();
    url ||= status.API_URL;
    secretKey ||= status.SECRET_KEY || status.SERVICE_ROLE_KEY;
  }
  if (!url || !secretKey) throw new Error("Could not find the local Supabase URL and secret key.");
  return { url: assertLocalSupabaseUrl(url), secretKey };
}

function check(result, what) {
  if (result.error) throw new Error(`${what}: ${result.error.message}${result.error.code ? ` (${result.error.code})` : ""}`);
  return result.data;
}

/** customers.channel (how reminders reach them) from SOB's preferred contact. */
const CHANNEL_FOR_CONTACT = { phone: "sms", whatsapp: "whatsapp", email: "email" };

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function seedGarages(supabase) {
  const garages = {};
  for (const garage of GARAGES) {
    const { key, ...fields } = garage;
    // Reuse a garage that already has the slug (created by hand or an older seed).
    const existing = check(await supabase.from("garages").select("id").eq("slug", garage.slug).maybeSingle(), `Look up garage ${garage.slug}`);
    const id = existing?.id ?? seedUuid(`garage:${garage.slug}`);
    const row = check(
      await supabase
        .from("garages")
        .upsert({ id, ...fields, timezone: "Europe/London", status: "active", cancelled_at: null }, { onConflict: "id" })
        .select("id, slug, name, booking_prefix, mot_enabled")
        .single(),
      `Upsert garage ${garage.slug}`,
    );
    garages[key] = row;
  }
  console.log(`  - garages: ${Object.values(garages).map((garage) => `${garage.name} (${garage.slug})`).join(", ")}`);
  return garages;
}

async function seedSiteSettings(supabase, garages) {
  const rows = Object.values(garages).map((garage) => ({ garage_id: garage.id, value: { demo: true } }));
  check(await supabase.from("site_settings").upsert(rows, { onConflict: "garage_id" }), "Upsert site settings");
  console.log(`  - site_settings: ${rows.length} rows`);
}

async function findUserByEmail(supabase, email) {
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`List users: ${error.message}`);
    const match = data.users.find((user) => user.email?.toLowerCase() === email);
    if (match) return match;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function ensureStaffUser(supabase, staff, password) {
  const attributes = { password, email_confirm: true, user_metadata: { display_name: staff.displayName, seed: "autofix-demo" } };
  const fixedId = seedUuid(`user:${staff.email}`);
  const byId = await supabase.auth.admin.getUserById(fixedId);
  let user = byId.data?.user ?? null;
  if (!user) user = await findUserByEmail(supabase, staff.email);
  if (user) {
    const updated = await supabase.auth.admin.updateUserById(user.id, attributes);
    if (updated.error) throw new Error(`Update user ${staff.email}: ${updated.error.message}`);
    return user.id;
  }
  const created = await supabase.auth.admin.createUser({ id: fixedId, email: staff.email, ...attributes });
  if (created.error || !created.data.user) throw new Error(`Create user ${staff.email}: ${created.error?.message}`);
  return created.data.user.id;
}

async function seedStaff(supabase, garages, password) {
  const users = [];
  for (const staff of STAFF) {
    const userId = await ensureStaffUser(supabase, staff, password);
    check(await supabase.from("admin_profiles").upsert({ user_id: userId, display_name: staff.displayName }, { onConflict: "user_id" }), `Upsert profile for ${staff.email}`);
    const memberships = staff.memberships.map(([garageKey, role]) => ({ garage_id: garages[garageKey].id, user_id: userId, role }));
    check(await supabase.from("garage_members").upsert(memberships, { onConflict: "garage_id,user_id" }), `Upsert memberships for ${staff.email}`);
    users.push({ ...staff, userId });
  }
  console.log(`  - staff: ${users.length} users`);
  return users;
}

async function seedMfaPolicy(supabase) {
  const relax = process.env.SEED_RELAX_MFA === "1";
  check(
    await supabase.from("admin_mfa_policy").update({ mandatory_mfa_enabled: !relax, updated_at: new Date().toISOString() }).eq("singleton", true),
    "Update admin MFA policy",
  );
  if (relax) {
    console.log("");
    console.log("  !! SEED_RELAX_MFA=1: mandatory MFA for garage owners is now OFF in this LOCAL database.");
    console.log("  !! Owners can sign in without TOTP. Never do this outside local development;");
    console.log("  !! run `pnpm db:seed` without the flag to turn it back on.");
    console.log("");
  } else {
    console.log("  - admin_mfa_policy: mandatory MFA on (shipped default); owners enrol TOTP on first sign-in");
  }
}

async function seedCustomersAndVehicles(supabase, garages) {
  let customerCount = 0;
  let vehicleCount = 0;
  for (const [garageKey, customers] of Object.entries(CUSTOMERS)) {
    const garage = garages[garageKey];
    const customerRows = [];
    const vehicleRows = [];
    for (const [name, phone, preferredContact, vehicles] of customers) {
      const customerId = seedUuid(`customer:${garage.slug}:${phone}`);
      const email = `${name.toLowerCase().replaceAll(" ", ".")}@example.com`;
      customerRows.push({
        id: customerId,
        garage_id: garage.id,
        name,
        phone,
        email,
        preferred_contact: preferredContact,
        channel: CHANNEL_FOR_CONTACT[preferredContact],
        anonymised_at: null,
      });
      for (const [registration, make, model, year, colour, fuel] of vehicles) {
        vehicleRows.push({
          id: seedUuid(`vehicle:${garage.slug}:${registration}`),
          garage_id: garage.id,
          customer_id: customerId,
          registration,
          make,
          model,
          year,
          colour,
          fuel,
        });
      }
    }
    check(await supabase.from("customers").upsert(customerRows, { onConflict: "id" }), `Upsert customers for ${garage.slug}`);
    check(await supabase.from("vehicles").upsert(vehicleRows, { onConflict: "id" }), `Upsert vehicles for ${garage.slug}`);
    customerCount += customerRows.length;
    vehicleCount += vehicleRows.length;
  }
  console.log(`  - customers: ${customerCount}, vehicles: ${vehicleCount}`);
}

async function seedEnquiries(supabase, garages) {
  let count = 0;
  for (const [garageKey, enquiries] of Object.entries(ENQUIRIES)) {
    const garage = garages[garageKey];
    for (const [customerName, type, status, description, postcode, driveable] of enquiries) {
      const customer = CUSTOMERS[garageKey].find(([name]) => name === customerName);
      if (!customer) throw new Error(`Seed data error: no customer ${customerName}`);
      const [, phone, , vehicles] = customer;
      const firstVehicle = vehicles[0];
      const enquiryId = seedUuid(`enquiry:${garage.slug}:${customerName}:${type}`);
      const subject = `Your ${type} enquiry with ${garage.name}`;
      check(
        await supabase.from("enquiries").upsert({
          id: enquiryId,
          garage_id: garage.id,
          type,
          status,
          customer_id: seedUuid(`customer:${garage.slug}:${phone}`),
          vehicle_id: firstVehicle ? seedUuid(`vehicle:${garage.slug}:${firstVehicle[0]}`) : null,
          description,
          location_postcode: postcode,
          driveable,
        }, { onConflict: "id" }),
        `Upsert enquiry for ${customerName}`,
      );
      check(
        await supabase.from("enquiry_conversations").upsert({ enquiry_id: enquiryId, garage_id: garage.id, subject, unread_count: status === "new" ? 1 : 0 }, { onConflict: "enquiry_id" }),
        `Upsert conversation for ${customerName}`,
      );
      check(
        await supabase.from("enquiry_messages").upsert({
          id: seedUuid(`enquiry-message:${enquiryId}:1`),
          garage_id: garage.id,
          enquiry_id: enquiryId,
          direction: "inbound",
          message_type: "website_enquiry",
          sender_name: customerName,
          subject,
          text_body: description,
          delivery_status: "received",
          is_read: status !== "new",
        }, { onConflict: "id" }),
        `Upsert first message for ${customerName}`,
      );
      count += 1;
    }
  }
  console.log(`  - enquiries: ${count} (with conversations and first messages)`);
}

// --- Scheduling (P2.1): RESOURCES, OPENING_HOURS, CLOSURES and SERVICES above.

async function seedResources(supabase, garages) {
  const rows = Object.values(garages).flatMap((garage) => RESOURCES.map((resource) => ({
    id: seedUuid(`resource:${garage.slug}:${resource.name}`),
    garage_id: garage.id,
    name: resource.name,
    kind: resource.kind,
    active: true,
    sort: resource.sort,
  })));
  check(await supabase.from("resources").upsert(rows, { onConflict: "id" }), "Upsert resources");
  console.log(`  - resources: ${rows.length} (3 bays + 1 mobile van per garage)`);
}

async function seedOpeningHours(supabase, garages) {
  const rows = Object.values(garages).flatMap((garage) => OPENING_HOURS.map((window) => ({
    id: seedUuid(`opening-hours:${garage.slug}:${window.weekday}:${window.opens}`),
    garage_id: garage.id,
    ...window,
  })));
  check(await supabase.from("opening_hours").upsert(rows, { onConflict: "id" }), "Upsert opening hours");
  console.log(`  - opening_hours: ${rows.length} (Mon-Fri 08:00-17:30, Sat 08:30-13:00)`);
}

async function seedClosures(supabase, garages) {
  const rows = Object.values(garages).flatMap((garage) => CLOSURES.map((closure) => ({
    id: seedUuid(`closure:${garage.slug}:${closure.starts_on}`),
    garage_id: garage.id,
    ...closure,
  })));
  check(await supabase.from("closures").upsert(rows, { onConflict: "id" }), "Upsert closures");
  console.log(`  - closures: ${rows.length}`);
}

async function seedServices(supabase, garages) {
  const rows = Object.values(garages).flatMap((garage) => SERVICES
    .filter((service) => !service.is_mot || garage.mot_enabled)
    .map(({ key, ...service }, index) => ({
      id: seedUuid(`service:${garage.slug}:${key}`),
      garage_id: garage.id,
      ...service,
      online_enabled: true,
      min_notice_h: 2,
      max_days_ahead: 60,
      sort: index + 1,
      deleted_at: null,
    })));
  check(await supabase.from("services").upsert(rows, { onConflict: "id" }), "Upsert services");
  console.log(`  - services: ${rows.length} (MOT only at garages with MOT enabled)`);
}

// ---------------------------------------------------------------------------

function printSummary(garages, staff) {
  console.log("");
  console.log("Demo garages (local):");
  for (const garage of Object.values(garages)) {
    console.log(`  ${garage.name.padEnd(22)} http://${garage.slug}.localhost:3000/   id ${garage.id}`);
  }
  console.log("");
  console.log("Staff sign-in at http://localhost:3000/app/login (password: SEED_STAFF_PASSWORD, default in scripts/seed-demo.mjs):");
  for (const user of staff) {
    const roles = user.memberships.map(([garageKey, role]) => `${role} at ${garages[garageKey].name}`).join(", ");
    console.log(`  ${user.email.padEnd(38)} ${roles}`);
  }
}

async function main() {
  const { url, secretKey } = resolveSupabase();
  const password = process.env.SEED_STAFF_PASSWORD?.trim() || DEFAULT_STAFF_PASSWORD;
  if (password.length < 8) throw new Error("SEED_STAFF_PASSWORD must be at least 8 characters.");
  const supabase = createClient(url, secretKey, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });

  console.log(`Seeding local Supabase at ${url}`);
  const garages = await seedGarages(supabase);
  await seedSiteSettings(supabase, garages);
  const staff = await seedStaff(supabase, garages, password);
  await seedMfaPolicy(supabase);
  await seedCustomersAndVehicles(supabase, garages);
  await seedEnquiries(supabase, garages);
  await seedResources(supabase, garages);
  await seedOpeningHours(supabase, garages);
  await seedClosures(supabase, garages);
  await seedServices(supabase, garages);
  printSummary(garages, staff);
}

main().catch((error) => {
  console.error(`\nSeed failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
