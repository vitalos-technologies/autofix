import { createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type LocalSupabaseConfig = {
  url: string;
  publishableKey: string;
  secretKey: string;
};

export type LocalTestIdentity = {
  id: string;
  email: string;
  accessToken: string;
};

export type LocalTestGarage = {
  id: string;
  slug: string;
  bookingPrefix: string;
  name: string;
};

export type LocalTestUsers = {
  /** Service role. Sends no garage header, so inserts must set garage_id. */
  service: SupabaseClient;
  anon: SupabaseClient;
  /** Owner of garage A (MFA verified), with garage A selected. */
  admin: SupabaseClient;
  /** A second owner of garage A (MFA verified), with garage A selected. */
  secondaryAdmin: SupabaseClient;
  /** Signed in but a member of no garage; sends garage A's id anyway. */
  nonAdmin: SupabaseClient;
  /** Owner of garage B (MFA verified), with garage B selected. */
  otherGarageAdmin: SupabaseClient;
  /** Garage B's owner sending garage A's id (a forged selection). */
  otherGarageAdminForgingGarageA: SupabaseClient;
  garageA: LocalTestGarage;
  garageB: LocalTestGarage;
  adminIdentity: LocalTestIdentity;
  secondaryAdminIdentity: LocalTestIdentity;
  nonAdminIdentity: LocalTestIdentity;
  otherGarageAdminIdentity: LocalTestIdentity;
};

const runId = randomUUID().replaceAll("-", "").slice(0, 10);
/** Random per test-file run; use it to keep fixture names unique. */
export const localRunId = runId;
export const localAdminEmail = `garage-a-owner-${runId}@example.test`;
export const localSecondaryAdminEmail = `garage-a-second-owner-${runId}@example.test`;
export const localOtherGarageAdminEmail = `garage-b-owner-${runId}@example.test`;
export const localTestPassword = "Local-only-9f2e7c4a!";

/**
 * The Supabase CLI project id: SUPABASE_PROJECT_ID, else `project_id` in
 * supabase/config.toml (sobautofix-local-tests locally; autofix-ci-<N> on CI
 * runners after scripts/ci/supabase-isolate.sh).
 */
export function localSupabaseProjectId() {
  const fromEnvironment = process.env.SUPABASE_PROJECT_ID?.trim();
  const projectId = fromEnvironment || /^project_id\s*=\s*"([^"]+)"/m.exec(readFileSync(resolve("supabase/config.toml"), "utf8"))?.[1];
  if (!projectId || !/^[A-Za-z0-9_.-]+$/.test(projectId)) throw new Error("Could not read a valid Supabase project_id");
  return projectId;
}

function localDatabaseContainer() {
  return `supabase_db_${localSupabaseProjectId()}`;
}

export function getLocalSupabaseConfig(): LocalSupabaseConfig {
  const url = firstEnvironmentValue("INTEGRATION_SUPABASE_URL", "API_URL", "SUPABASE_URL");
  const publishableKey = firstEnvironmentValue(
    "INTEGRATION_SUPABASE_PUBLISHABLE_KEY",
    "PUBLISHABLE_KEY",
    "ANON_KEY",
  );
  const secretKey = firstEnvironmentValue(
    "INTEGRATION_SUPABASE_SECRET_KEY",
    "SECRET_KEY",
    "SERVICE_ROLE_KEY",
  );

  const parsed = new URL(url);
  // The safety guard: a local stack only (loopback host, plain http). Any port,
  // because CI runners on one machine each run their own stack on shifted ports.
  const isLoopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1" || parsed.hostname === "[::1]";
  if (!isLoopback || parsed.protocol !== "http:") {
    throw new Error(`Refusing to run database integration tests against non-local Supabase URL: ${parsed.origin}`);
  }

  return { url: parsed.origin, publishableKey, secretKey };
}

/**
 * A PostgREST client. `garageId` is sent as the x-garage-id header, which the
 * database honours only for members of that garage (or the service role).
 */
export function createLocalClient(key: string, accessToken?: string, garageId?: string) {
  const { url } = getLocalSupabaseConfig();
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (garageId) headers["x-garage-id"] = garageId;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: Object.keys(headers).length ? { headers } : undefined,
  });
}

export async function provisionLocalTestUsers(): Promise<LocalTestUsers> {
  const config = getLocalSupabaseConfig();
  const service = createLocalClient(config.secretKey);
  const anon = createLocalClient(config.publishableKey);

  const garageA = await createLocalGarage(service, "a");
  const garageB = await createLocalGarage(service, "b");

  // Owners are created first so that MFA enrollment happens before they are
  // used; mandatory MFA for owners stays on, as in production.
  const adminIdentity = await createLocalMfaIdentity(service, config.publishableKey, localAdminEmail);
  const secondaryAdminIdentity = await createLocalMfaIdentity(service, config.publishableKey, localSecondaryAdminEmail);
  const otherGarageAdminIdentity = await createLocalMfaIdentity(service, config.publishableKey, localOtherGarageAdminEmail);
  const nonAdminIdentity = await createLocalIdentity(service, config.publishableKey, `no-garage-${runId}@example.test`);

  const { error: membershipError } = await service.from("garage_members").insert([
    { garage_id: garageA.id, user_id: adminIdentity.id, role: "owner" },
    { garage_id: garageA.id, user_id: secondaryAdminIdentity.id, role: "owner" },
    { garage_id: garageB.id, user_id: otherGarageAdminIdentity.id, role: "owner" },
  ]);
  if (membershipError) throw new Error(`Could not add local garage members: ${membershipError.message}`);

  const { error: profileError } = await service.from("admin_profiles").upsert([
    { user_id: adminIdentity.id, display_name: "Garage A Test Owner" },
    { user_id: secondaryAdminIdentity.id, display_name: "Garage A Second Test Owner" },
    { user_id: otherGarageAdminIdentity.id, display_name: "Garage B Test Owner" },
  ]);
  if (profileError) throw new Error(`Could not add local staff profiles: ${profileError.message}`);

  return {
    service,
    anon,
    admin: createLocalClient(config.publishableKey, adminIdentity.accessToken, garageA.id),
    secondaryAdmin: createLocalClient(config.publishableKey, secondaryAdminIdentity.accessToken, garageA.id),
    nonAdmin: createLocalClient(config.publishableKey, nonAdminIdentity.accessToken, garageA.id),
    otherGarageAdmin: createLocalClient(config.publishableKey, otherGarageAdminIdentity.accessToken, garageB.id),
    otherGarageAdminForgingGarageA: createLocalClient(config.publishableKey, otherGarageAdminIdentity.accessToken, garageA.id),
    garageA,
    garageB,
    adminIdentity,
    secondaryAdminIdentity,
    nonAdminIdentity,
    otherGarageAdminIdentity,
  };
}

function runLocalOwnerPsql(sql: string, variables: Record<string, string>, extraArguments: string[]) {
  getLocalSupabaseConfig();
  const variableArguments = Object.entries(variables).flatMap(([name, value]) => {
    if (!/^[a-z][a-z0-9_]*$/i.test(name)) throw new Error(`Invalid local SQL variable name: ${name}`);
    return ["--set", `${name}=${value}`];
  });

  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "--env",
      "PGPASSWORD=postgres",
      localDatabaseContainer(),
      "psql",
      "--host",
      "127.0.0.1",
      "--username",
      "postgres",
      "--dbname",
      "postgres",
      "--no-psqlrc",
      "--quiet",
      "--set",
      "ON_ERROR_STOP=1",
      ...extraArguments,
      ...variableArguments,
    ],
    { input: sql, encoding: "utf8", timeout: 15_000, windowsHide: true },
  );
}

export function executeLocalOwnerSql(sql: string, variables: Record<string, string> = {}) {
  try {
    runLocalOwnerPsql(sql, variables, []);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not seed the isolated local Supabase database as owner: ${detail}`);
  }
}

/**
 * Runs one read-only query as the database owner (psql in the local DB
 * container, bypassing PostgREST and RLS) and returns its rows. `sql` is a
 * single SELECT; psql variables are referenced as `:'name'`.
 */
export function queryLocalOwnerSql<T = Record<string, unknown>>(sql: string, variables: Record<string, string> = {}): T[] {
  const select = sql.trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(select)) throw new Error("queryLocalOwnerSql takes a single SELECT");
  let output: string;
  try {
    output = runLocalOwnerPsql(
      `begin read only;\nselect coalesce(jsonb_agg(to_jsonb(result)), '[]'::jsonb) from (\n${select}\n) result;\ncommit;\n`,
      variables,
      ["--tuples-only", "--no-align"],
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not query the local Supabase database as owner: ${detail}`);
  }
  const json = output.split("\n").map((line) => line.trim()).find((line) => line.startsWith("["));
  if (!json) throw new Error(`Owner query returned no JSON: ${output.slice(0, 200)}`);
  return JSON.parse(json) as T[];
}

export function invoiceDraftPayload(issueDate: string, suffix = randomUUID().slice(0, 8)) {
  return {
    source_type: "manual",
    booking_id: "",
    enquiry_id: "",
    customer_id: "",
    vehicle_id: "",
    customer_name: `Local Test Customer ${suffix}`,
    customer_email: `invoice-${suffix}@example.test`,
    customer_phone: "07000000000",
    customer_address: "1 Local Test Street, Doncaster, DN1 1AA",
    vehicle_registration: `T${suffix.slice(0, 6)}`,
    vehicle_make: "Test",
    vehicle_model: "Fixture",
    service_name: "Concurrency test",
    appointment_start: "",
    issue_date: issueDate,
    due_date: "",
    discount_pence: "0",
    tax_pence: "0",
    notes: "Local integration data only.",
    payment_terms: "Payment due within 7 days.",
    items: [{ description: "Exact fractional work", quantity: "1.250", unit_price_pence: "799" }],
  };
}

/**
 * Creates an active garage for this run. `label` is one or two lower-case
 * letters (it becomes part of the slug and the booking prefix).
 */
export async function createLocalGarage(service: SupabaseClient, label: string): Promise<LocalTestGarage> {
  if (!/^[a-z]{1,2}$/.test(label)) throw new Error(`Invalid local garage label: ${label}`);
  // Two to four upper-case letters, unique enough per run.
  const letters = runId.replace(/[^a-z]/g, "").toUpperCase().padEnd(2, "X").slice(0, 2);
  const garage = {
    slug: `it-${label}-${runId}`,
    name: `Integration Garage ${label.toUpperCase()} ${runId}`,
    booking_prefix: `${letters}${label.toUpperCase()}`,
    legal_name: `Integration Garage ${label.toUpperCase()} Limited`,
    email: `garage-${label}-${runId}@example.test`,
    phone: label.endsWith("a") ? "+441302000101" : "+441302000102",
    address: { line1: `${label.endsWith("a") ? 1 : 2} Test Street`, town: "Doncaster", postcode: "DN1 1AA" },
    status: "active",
  };
  const { data, error } = await service.from("garages").insert(garage).select("id,slug,booking_prefix,name").single();
  if (error || !data) throw new Error(`Could not create local garage ${label}: ${error?.message}`);
  return { id: data.id, slug: data.slug, bookingPrefix: data.booking_prefix, name: data.name };
}

/** A confirmed Auth user signed in with a password (AAL1). */
export async function createLocalIdentity(service: SupabaseClient, publishableKey: string, email: string): Promise<LocalTestIdentity> {
  const { data: created, error: createError } = await service.auth.admin.createUser({
    email,
    password: localTestPassword,
    email_confirm: true,
  });
  if (createError || !created.user) throw new Error(`Could not create local Auth user ${email}: ${createError?.message}`);

  const authClient = createLocalClient(publishableKey);
  const { data: signedIn, error: signInError } = await authClient.auth.signInWithPassword({ email, password: localTestPassword });
  if (signInError || !signedIn.session) throw new Error(`Could not sign in local Auth user ${email}: ${signInError?.message}`);

  return { id: created.user.id, email, accessToken: signedIn.session.access_token };
}

/** A confirmed Auth user with a verified TOTP factor, signed in at AAL2. */
export async function createLocalMfaIdentity(service: SupabaseClient, publishableKey: string, email: string): Promise<LocalTestIdentity> {
  const identity = await createLocalIdentity(service, publishableKey, email);

  const authClient = createLocalClient(publishableKey);
  const { error: signInError } = await authClient.auth.signInWithPassword({ email, password: localTestPassword });
  if (signInError) throw new Error(`Could not start local MFA session for ${email}: ${signInError.message}`);
  const { data: enrollment, error: enrollmentError } = await authClient.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: "Local integration tests",
  });
  if (enrollmentError || !enrollment || enrollment.type !== "totp") {
    throw new Error(`Could not enroll local MFA for ${email}: ${enrollmentError?.message || "TOTP unavailable"}`);
  }
  const { data: verified, error: verificationError } = await authClient.auth.mfa.challengeAndVerify({
    factorId: enrollment.id,
    code: currentTotp(enrollment.totp.secret),
  });
  if (verificationError || !verified.access_token) {
    throw new Error(`Could not verify local MFA for ${email}: ${verificationError?.message || "AAL2 token unavailable"}`);
  }
  return { id: identity.id, email, accessToken: verified.access_token };
}

function currentTotp(secret: string) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", decodeBase32(secret)).update(counter).digest();
  const lastByte = digest[digest.length - 1];
  if (lastByte === undefined) throw new Error("Local TOTP digest is empty");
  const offset = lastByte & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

function decodeBase32(value: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of value.replace(/=+$/g, "").toUpperCase()) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("Local TOTP secret contains an invalid base32 character");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

function firstEnvironmentValue(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`Missing local Supabase test environment variable (${names.join(" or ")}).`);
}
