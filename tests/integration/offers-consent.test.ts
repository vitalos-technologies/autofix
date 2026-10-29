import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getLocalSupabaseConfig, provisionLocalTestUsers, type LocalTestUsers } from "../helpers/local-supabase";

// Offers consent (migration 20261029001400_offers_consent, consent wording v1.0) through the real
// booking engine and PostgREST against local Supabase: the booking page's offers box is stored
// apart from reminders with its exact wording, a later unticked booking keeps it, staff can neither
// record it on a booking nor write it by hand, a staff opt-out ends it, "Turn reminders back on"
// never brings it back, and the campaign audience follows it. pgTAP 039 covers the SQL in depth.
// Skipped only when no local database is configured.

const configured = Boolean(process.env.INTEGRATION_SUPABASE_URL);

type Engine = typeof import("../../src/lib/booking-engine/repository");
type Slot = { startsAt: string; endsAt: string; freeCount: number };

const OFFERS_PHONE = "+447700900611";
const REMINDERS_PHONE = "+447700900612";

let users: LocalTestUsers;
let engineModule: Engine;
let service: SupabaseClient;
let diagnostics: string;
let slots: Slot[];
let wording: string;

function londonDate(days: number) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(Date.now() + days * 86_400_000));
}

function bookingInput(slot: Slot, phone: string, customer: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    serviceId: diagnostics,
    startsAt: slot.startsAt,
    locationMode: "workshop" as const,
    symptoms: [],
    customer: { name: "Offers Customer", phone, channel: "sms" as const, reminderConsent: false, ...customer },
    vehicle: { registration: `OC${phone.slice(-3)}${randomUUID().slice(0, 2)}`.toUpperCase() },
    idempotencyKey: randomUUID(),
    source: "online" as const,
    ...overrides,
  };
}

async function customerRow(phone: string) {
  const { data, error } = await service
    .from("customers")
    .select("id,reminder_consent,consent_source,offers_consent,offers_consent_at,offers_consent_source,offers_consent_text,offers_opted_out_at,opted_out_at")
    .eq("garage_id", users.garageA.id)
    .eq("phone", phone)
    .single();
  if (error || !data) throw new Error(`No customer ${phone}: ${error?.message}`);
  return data as {
    id: string;
    reminder_consent: boolean;
    consent_source: string | null;
    offers_consent: boolean;
    offers_consent_at: string | null;
    offers_consent_source: string | null;
    offers_consent_text: string | null;
    offers_opted_out_at: string | null;
    opted_out_at: string | null;
  };
}

describe.skipIf(!configured).sequential("offers consent against local Supabase", () => {
  beforeAll(async () => {
    const config = getLocalSupabaseConfig();
    process.env.NEXT_PUBLIC_SUPABASE_URL = config.url;
    process.env.SUPABASE_SECRET_KEY = config.secretKey;
    process.env.BOOKING_MANAGEMENT_SECRET = "integration-booking-management-secret-0123456789";
    users = await provisionLocalTestUsers();
    service = users.service;
    // Campaigns are a Pro feature.
    const plan = await service.from("garages").update({ plan: "pro", plan_chosen: "pro", trial_ends_at: null }).eq("id", users.garageA.id);
    if (plan.error) throw new Error(`Could not set the plan: ${plan.error.message}`);
    const seeded = await service.rpc("seed_garage_defaults", { p_garage_id: users.garageA.id });
    if (seeded.error) throw new Error(`seed_garage_defaults failed: ${seeded.error.message}`);
    const found = await service.from("services").select("id").eq("garage_id", users.garageA.id).eq("name", "Diagnostics").single();
    if (found.error || !found.data) throw new Error(`No Diagnostics service: ${found.error?.message}`);
    diagnostics = (found.data as { id: string }).id;
    engineModule = await import("../../src/lib/booking-engine/repository");
    const { offersConsentCopy } = await import("../../src/lib/booking-flow/copy");
    wording = offersConsentCopy(users.garageA.name);
    // One free start per day, so the bookings below never compete for the bays.
    const free = (await engine().getAvailableSlots({ garageId: users.garageA.id, serviceId: diagnostics, from: londonDate(2), to: londonDate(12) })).filter((slot) => slot.freeCount > 0);
    const days = new Map<string, Slot>();
    for (const slot of free) {
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(slot.startsAt));
      if (!days.has(day)) days.set(day, slot);
    }
    slots = [...days.values()];
    if (slots.length < 5) throw new Error("Not enough free days for the offers tests");
  });

  const engine = () => engineModule.createSupabaseBookingEngine({ client: () => service });

  it("stores a ticked offers box apart from reminders, with source booking and the exact wording", async () => {
    const created = await engine().createBooking(users.garageA.id, bookingInput(slots[0]!, OFFERS_PHONE, { offersConsent: true, offersConsentText: wording }));
    expect(created).toMatchObject({ ok: true });
    const stored = await customerRow(OFFERS_PHONE);
    expect(stored).toMatchObject({ reminder_consent: false, offers_consent: true, offers_consent_source: "booking", offers_consent_text: wording });
    expect(stored.offers_consent_at).toBeTruthy();

    expect(await engine().createBooking(users.garageA.id, bookingInput(slots[1]!, REMINDERS_PHONE, { reminderConsent: true, consentText: "Remind me when the MOT and service are due. You can stop these any time." })))
      .toMatchObject({ ok: true });
    expect(await customerRow(REMINDERS_PHONE)).toMatchObject({ reminder_consent: true, offers_consent: false, offers_consent_source: null, offers_consent_text: null });
  });

  it("keeps offers consent when a later booking leaves the box unticked", async () => {
    const before = await customerRow(OFFERS_PHONE);
    expect(await engine().createBooking(users.garageA.id, bookingInput(slots[2]!, OFFERS_PHONE, { offersConsent: false }))).toMatchObject({ ok: true });
    const after = await customerRow(OFFERS_PHONE);
    expect(after).toMatchObject({ offers_consent: true, offers_consent_text: wording });
    expect(after.offers_consent_at).toBe(before.offers_consent_at);
  });

  it("never records offers consent on a staff booking", async () => {
    const refused = await engine().createBooking(
      users.garageA.id,
      bookingInput(slots[3]!, REMINDERS_PHONE, { offersConsent: true, offersConsentText: wording }, { source: "phone" }),
      { staff: { memberId: users.adminIdentity.id, overrideHours: false } },
    );
    expect(refused).toMatchObject({ ok: false, code: "INVALID_BOOKING" });
    expect(await customerRow(REMINDERS_PHONE)).toMatchObject({ offers_consent: false });
  });

  it("puts only offers consent in the campaign audience preview", async () => {
    const { data, error } = await users.admin.rpc("preview_campaign_audience", { p_segment: {}, p_limit: 20 });
    expect(error).toBeNull();
    const rows = data as Array<{ total: number; offers_total: number; phone: string | null; consent_basis: string | null }>;
    expect(rows.map((row) => [row.phone, row.consent_basis])).toEqual([[OFFERS_PHONE, "offers"]]);
    expect(rows[0]).toMatchObject({ total: 1, offers_total: 1 });
  });

  it("does not let staff tick or untick offers consent by hand", async () => {
    const reminders = await customerRow(REMINDERS_PHONE);
    const tick = await users.admin
      .from("customers")
      .update({ offers_consent: true, offers_consent_at: new Date().toISOString(), offers_consent_source: "booking", offers_consent_text: wording })
      .eq("id", reminders.id);
    expect(tick.error?.code).toBe("42501");
    const offers = await customerRow(OFFERS_PHONE);
    const untick = await users.admin.from("customers").update({ offers_consent: false }).eq("id", offers.id);
    expect(untick.error?.code).toBe("42501");
    const rename = await users.admin.from("customers").update({ name: "Renamed by staff" }).eq("id", offers.id);
    expect(rename.error).toBeNull();
    expect(await customerRow(OFFERS_PHONE)).toMatchObject({ offers_consent: true });
  });

  it("ends offers consent on a staff opt-out, and turning reminders back on does not restore it", async () => {
    const offers = await customerRow(OFFERS_PHONE);
    // The admin's "Opt out of reminders and offers" button writes opted_out_at through RLS.
    const optOut = await users.admin.from("customers").update({ opted_out_at: new Date().toISOString() }).eq("id", offers.id);
    expect(optOut.error).toBeNull();
    const optedOut = await customerRow(OFFERS_PHONE);
    expect(optedOut).toMatchObject({ offers_consent: false });
    expect(optedOut.offers_opted_out_at).toBe(optedOut.opted_out_at);

    const resumed = await service.rpc("resume_customer_reminders", {
      p_garage_id: users.garageA.id,
      p_customer_id: offers.id,
      p_consent_text: `Reminders are back on. ${users.garageA.name} will send you reminders again. You can stop them any time.`,
    });
    expect(resumed.error).toBeNull();
    expect(await customerRow(OFFERS_PHONE)).toMatchObject({ opted_out_at: null, reminder_consent: true, consent_source: "unsubscribe_page", offers_consent: false });

    const { data } = await users.admin.rpc("preview_campaign_audience", { p_segment: {}, p_limit: 20 });
    expect((data as Array<{ total: number }>)[0]?.total).toBe(0);

    // Only a fresh tick on a booking turns offers back on.
    expect(await engine().createBooking(users.garageA.id, bookingInput(slots[4]!, OFFERS_PHONE, { offersConsent: true, offersConsentText: wording }))).toMatchObject({ ok: true });
    expect(await customerRow(OFFERS_PHONE)).toMatchObject({ offers_consent: true });
  });
});
