/**
 * Garage staff for the browser tests: confirmed Auth users with a verified TOTP factor (mandatory
 * MFA stays on, as shipped), garage memberships and a profile, so specs sign in through the real
 * password + MFA screens (or reuse the AAL2 session cookies from enrolment). Each run makes its own
 * users and never touches the seeded staff's factors. Local stack only.
 *   - `createTotpMember` / `signInWithTotp`: one garage, one role (tests/e2e/settings.spec.ts).
 *   - `createStaffUser` / `nextCode`: several memberships, cookies for a second browser
 *     (tests/e2e/admin.spec.ts), plus today's bookings for the admin pages.
 */
import { createHmac, randomInt, randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createLocalClient, getLocalSupabaseConfig, localTestPassword } from "./local-supabase";
import { randomRegistration, serviceClient, type SeededGarage } from "./booking-fixtures";

const TOTP_STEP_MS = 30_000;

export type TotpMember = {
  id: string;
  email: string;
  secret: string;
  /** TOTP window of the last code used, so no code is replayed. */
  lastWindow: number;
};

export async function createTotpMember(
  service: SupabaseClient,
  garageId: string,
  role: "owner" | "manager" | "technician",
  label: string,
): Promise<TotpMember> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const { data: created, error: createError } = await service.auth.admin.createUser({ email, password: localTestPassword, email_confirm: true });
  if (createError || !created.user) throw new Error(`Could not create local ${role}: ${createError?.message}`);
  const { error: membershipError } = await service.from("garage_members").insert({ garage_id: garageId, user_id: created.user.id, role });
  if (membershipError) throw new Error(`Could not add local ${role}: ${membershipError.message}`);
  await service.from("admin_profiles").upsert({ user_id: created.user.id, display_name: `Test ${role}` });

  const auth = createLocalClient(getLocalSupabaseConfig().publishableKey);
  const { error: signInError } = await auth.auth.signInWithPassword({ email, password: localTestPassword });
  if (signInError) throw new Error(`Could not sign in local ${role}: ${signInError.message}`);
  const { data: enrollment, error: enrollmentError } = await auth.auth.mfa.enroll({ factorType: "totp", friendlyName: `${label} e2e` });
  if (enrollmentError || !enrollment || enrollment.type !== "totp") throw new Error(`Could not enrol TOTP for ${role}: ${enrollmentError?.message}`);
  const window = currentWindow();
  const { error: verifyError } = await auth.auth.mfa.challengeAndVerify({ factorId: enrollment.id, code: totp(enrollment.totp.secret, window) });
  if (verifyError) throw new Error(`Could not verify TOTP for ${role}: ${verifyError.message}`);
  return { id: created.user.id, email, secret: enrollment.totp.secret, lastWindow: window };
}

/**
 * A Vitalos platform admin (P4.5): a confirmed Auth user in `platform_admins` with a verified TOTP factor and
 * no garage. They sign in at /app/login and verify at /admin/verify (`signInAsPlatformAdmin`).
 */
export async function createTotpPlatformAdmin(service: SupabaseClient, label: string): Promise<TotpMember> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const { data: created, error: createError } = await service.auth.admin.createUser({ email, password: localTestPassword, email_confirm: true });
  if (createError || !created.user) throw new Error(`Could not create local platform admin: ${createError?.message}`);
  const { error: adminError } = await service.from("platform_admins").insert({ user_id: created.user.id });
  if (adminError) throw new Error(`Could not add local platform admin: ${adminError.message}`);
  await service.from("admin_profiles").upsert({ user_id: created.user.id, display_name: "Vitalos support" });

  const auth = createLocalClient(getLocalSupabaseConfig().publishableKey);
  const { error: signInError } = await auth.auth.signInWithPassword({ email, password: localTestPassword });
  if (signInError) throw new Error(`Could not sign in local platform admin: ${signInError.message}`);
  const { data: enrollment, error: enrollmentError } = await auth.auth.mfa.enroll({ factorType: "totp", friendlyName: `${label} e2e` });
  if (enrollmentError || !enrollment || enrollment.type !== "totp") throw new Error(`Could not enrol TOTP: ${enrollmentError?.message}`);
  const window = currentWindow();
  const { error: verifyError } = await auth.auth.mfa.challengeAndVerify({ factorId: enrollment.id, code: totp(enrollment.totp.secret, window) });
  if (verifyError) throw new Error(`Could not verify TOTP: ${verifyError.message}`);
  return { id: created.user.id, email, secret: enrollment.totp.secret, lastWindow: window };
}

/** Signs a platform admin in at /app/login, then verifies the TOTP code at /admin/verify, and waits for /admin. */
export async function signInAsPlatformAdmin(page: Page, adminOrigin: string, member: TotpMember) {
  await page.goto(`${adminOrigin}/app/login`);
  await page.getByLabel("Email").fill(member.email);
  await page.getByLabel("Password").fill(localTestPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin\/verify$/);
  const window = await nextUnusedWindow(member);
  await page.getByLabel("Verification code").fill(totp(member.secret, window));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

/** Signs in at `<adminOrigin>/app/login` with the password, then the TOTP code, and waits for the admin home. */
export async function signInWithTotp(page: Page, adminOrigin: string, member: TotpMember) {
  await page.goto(`${adminOrigin}/app/login`);
  await page.getByLabel("Email").fill(member.email);
  await page.getByLabel("Password").fill(localTestPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app\/mfa(?:\?.*)?$/);
  const window = await nextUnusedWindow(member);
  await page.getByLabel("Verification code").fill(totp(member.secret, window));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(/\/app(?:\/)?(?:\?.*)?$/);
}

/** Waits (at most one step) for a TOTP window that has not been used, with time left for the round trip. */
async function nextUnusedWindow(member: TotpMember) {
  while (currentWindow() <= member.lastWindow) {
    await new Promise((resolve) => setTimeout(resolve, (member.lastWindow + 1) * TOTP_STEP_MS - Date.now() + 250));
  }
  if (TOTP_STEP_MS - (Date.now() % TOTP_STEP_MS) < 3_000) {
    await new Promise((resolve) => setTimeout(resolve, TOTP_STEP_MS - (Date.now() % TOTP_STEP_MS) + 250));
  }
  member.lastWindow = currentWindow();
  return member.lastWindow;
}


export type StaffMembership = { garageId: string; role: "owner" | "manager" | "technician" };

export type StaffUser = {
  id: string;
  email: string;
  password: string;
  displayName: string;
  secret: string;
  /** TOTP window of the last code used, so no code is replayed. */
  lastWindow: number;
  /** AAL2 session cookies from enrolment, for tests that do not exercise the sign-in screens. */
  cookies: Array<{ name: string; value: string; url: string }>;
};

/** Password sign-in through the SSR client, keeping its cookies for a browser on `origin`. */
async function ssrSession(email: string, password: string, origin: string) {
  const { url, publishableKey } = getLocalSupabaseConfig();
  const jar = new Map<string, string>();
  const client = createServerClient(url, publishableKey, {
    cookies: {
      getAll: () => Array.from(jar, ([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const cookie of cookies) {
          if (cookie.options.maxAge === 0) jar.delete(cookie.name);
          else jar.set(cookie.name, cookie.value);
        }
      },
    },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`Could not sign in ${email}: ${error?.message ?? "no session"}`);
  return { client, cookies: () => Array.from(jar, ([name, value]) => ({ name, value, url: origin })) };
}

function currentWindow() {
  return Math.floor(Date.now() / TOTP_STEP_MS);
}

function base32(value: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of value.replace(/=+$/g, "").toUpperCase()) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("TOTP secret is not base32");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  return Buffer.from(bytes);
}

export function totp(secret: string, window: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(window));
  const digest = createHmac("sha1", base32(secret)).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** A fresh TOTP code (waits for the next window if this one was used or is about to end). */
export async function nextCode(user: StaffUser) {
  return totp(user.secret, await nextUnusedWindow(user));
}

/** Creates a staff user with the given memberships and a verified TOTP factor. */
export async function createStaffUser(label: string, displayName: string, memberships: StaffMembership[], origin: string): Promise<StaffUser> {
  const service = serviceClient();
  const email = `admin-e2e-${label}-${randomUUID().slice(0, 8)}@example.test`;
  const { data: created, error } = await service.auth.admin.createUser({ email, password: localTestPassword, email_confirm: true, user_metadata: { display_name: displayName } });
  if (error || !created.user) throw new Error(`Could not create ${label}: ${error?.message}`);
  const userId = created.user.id;
  const profile = await service.from("admin_profiles").upsert({ user_id: userId, display_name: displayName }, { onConflict: "user_id" });
  if (profile.error) throw new Error(`Could not add a profile for ${label}: ${profile.error.message}`);
  const members = await service.from("garage_members").insert(memberships.map((membership) => ({ garage_id: membership.garageId, user_id: userId, role: membership.role })));
  if (members.error) throw new Error(`Could not add memberships for ${label}: ${members.error.message}`);

  const session = await ssrSession(email, localTestPassword, origin);
  const { data: factor, error: enrollError } = await session.client.auth.mfa.enroll({ factorType: "totp", friendlyName: `Admin e2e ${label}` });
  if (enrollError || !factor || factor.type !== "totp") throw new Error(`Could not enrol TOTP for ${label}: ${enrollError?.message}`);
  const window = currentWindow();
  const { error: verifyError } = await session.client.auth.mfa.challengeAndVerify({ factorId: factor.id, code: totp(factor.totp.secret, window) });
  if (verifyError) throw new Error(`Could not verify TOTP for ${label}: ${verifyError.message}`);
  return { id: userId, email, password: localTestPassword, displayName, secret: factor.totp.secret, lastWindow: window, cookies: session.cookies() };
}

export async function deleteStaffUsers(users: readonly StaffUser[]) {
  for (const user of users) await serviceClient().auth.admin.deleteUser(user.id).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Today's bookings
// ---------------------------------------------------------------------------

export type TodayFixture = { id: string; reference: string; registration: string; status: string; startsAt: string; customerName: string; service: string };

function londonDate(offsetDays: number) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(Date.now() + offsetDays * 86_400_000));
}

/** The instant `HH:MM` London time today. */
function londonToday(minutes: number) {
  const date = londonDate(0);
  for (const offset of ["+00:00", "+01:00"]) {
    const candidate = new Date(`${date}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00${offset}`);
    const shown = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(candidate);
    if (shown === `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`) return candidate;
  }
  throw new Error("Could not place a time today");
}

async function serviceRow(garageId: string, name: string) {
  const { data, error } = await serviceClient().from("services").select("id,duration_min").eq("garage_id", garageId).eq("name", name).is("deleted_at", null).single();
  if (error || !data) throw new Error(`No ${name} service: ${error?.message}`);
  return data as { id: string; duration_min: number };
}

/**
 * Books a car through `create_booking()` on a free future slot, then moves it to today at about
 * `minutes` past midnight (London) on its bay and sets `status`, as the day would have gone.
 * Tries later times when the bay is busy (the `no_overlap` constraint still decides).
 */
export async function createTodayBooking(
  garage: SeededGarage,
  options: { service: string; minutes: number; status: string; customerName: string; make: string; model: string },
): Promise<TodayFixture> {
  const service = await serviceRow(garage.id, options.service);
  const { data: slots, error: slotError } = await serviceClient().rpc("available_slots", {
    p_garage_id: garage.id,
    p_service_id: service.id,
    p_from: londonDate(1),
    p_to: londonDate(14),
    p_location_mode: "workshop",
  });
  if (slotError) throw new Error(`available_slots failed: ${slotError.message}`);
  const free = (slots as Array<{ starts_at: string; free_count: number }>).filter((slot) => slot.free_count > 0);
  if (free.length === 0) throw new Error("No free slot for a Today fixture");
  const slot = free[randomInt(Math.min(free.length, 60))]!;
  const registration = randomRegistration();
  const { data, error } = await serviceClient().rpc("create_booking", {
    p_garage_id: garage.id,
    p_booking: {
      service_id: service.id,
      starts_at: slot.starts_at,
      location_mode: "workshop",
      source: "phone",
      idempotency_key: randomUUID(),
      symptoms: [],
      customer: { name: options.customerName, phone: `+447700900${randomInt(500, 999)}`, channel: "sms", reminder_consent: false },
      vehicle: { registration, make: options.make, model: options.model },
    },
  });
  if (error) throw new Error(`create_booking failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as { booking_id: string; reference: string; starts_at: string; ends_at: string };
  const length = Date.parse(row.ends_at) - Date.parse(row.starts_at);
  const { data: bays } = await serviceClient().from("resources").select("id").eq("garage_id", garage.id).eq("kind", "bay").eq("active", true).order("sort");
  const bayIds = ((bays ?? []) as Array<{ id: string }>).map((bay) => bay.id);

  // Up to 8 hours later than asked, never past the end of the day.
  for (let attempt = 0; attempt < 32 && options.minutes + attempt * 15 < 23 * 60; attempt += 1) {
    const start = londonToday(options.minutes + attempt * 15);
    const end = new Date(start.getTime() + length);
    // Each bay at this time, then 15 minutes later (the no_overlap constraint decides).
    for (const resourceId of bayIds.length ? bayIds : [null]) {
      const { error: moveError } = await serviceClient()
        .from("bookings")
        .update({
          starts_at: start.toISOString(),
          ends_at: end.toISOString(),
          during: `[${start.toISOString()},${end.toISOString()})`,
          status: options.status,
          ...(resourceId ? { resource_id: resourceId } : {}),
        })
        .eq("id", row.booking_id);
      if (!moveError) {
        return { id: row.booking_id, reference: row.reference, registration, status: options.status, startsAt: start.toISOString(), customerName: options.customerName, service: options.service };
      }
      if (moveError.code !== "23P01") {
        await deleteBookings([row.booking_id]);
        throw new Error(`Could not move the booking to today: ${moveError.message}`);
      }
    }
  }
  await deleteBookings([row.booking_id]);
  throw new Error("No free bay today for a fixture");
}

/** Books a request (a service that needs the garage's OK) a few days ahead. */
export async function createRequestBooking(garage: SeededGarage, customerName: string): Promise<TodayFixture> {
  const service = await serviceRow(garage.id, "Brakes");
  const { data: slots, error: slotError } = await serviceClient().rpc("available_slots", {
    p_garage_id: garage.id,
    p_service_id: service.id,
    p_from: londonDate(1),
    p_to: londonDate(14),
    p_location_mode: "workshop",
  });
  if (slotError) throw new Error(`available_slots failed: ${slotError.message}`);
  const free = (slots as Array<{ starts_at: string; free_count: number }>).filter((slot) => slot.free_count > 0);
  const slot = free[randomInt(Math.min(free.length, 60))]!;
  const registration = randomRegistration();
  const { data, error } = await serviceClient().rpc("create_booking", {
    p_garage_id: garage.id,
    p_booking: {
      service_id: service.id,
      starts_at: slot.starts_at,
      location_mode: "workshop",
      source: "online",
      idempotency_key: randomUUID(),
      symptoms: ["Grinding noise"],
      customer: { name: customerName, phone: `+447700900${randomInt(500, 999)}`, channel: "sms", reminder_consent: false },
      vehicle: { registration, make: "Ford", model: "Focus" },
    },
  });
  if (error) throw new Error(`create_booking failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as { booking_id: string; reference: string; status: string; starts_at: string };
  if (row.status !== "requested") throw new Error(`Expected a request, got ${row.status} (does Brakes still need approval?)`);
  return { id: row.booking_id, reference: row.reference, registration, status: row.status, startsAt: row.starts_at, customerName, service: "Brakes" };
}

/** Removes the spec's bookings (their events go with them). */
export async function deleteBookings(ids: readonly string[]) {
  if (ids.length === 0) return;
  await serviceClient().from("bookings").delete().in("id", [...ids]);
}
