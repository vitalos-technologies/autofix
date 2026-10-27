/**
 * The job queue and the reminder pipeline through PostgREST (P3.6): the calls
 * the job runner (P3.7) and the reminder link flow (P3.9) make as the service
 * role, with the argument names and result shapes pinned in
 * docs/autofix/ARCHITECTURE.md ("Admin, reminders and jobs"). Backoff,
 * scheduling rules, skip reasons, clock-change days and the two-session
 * skip-locked check are in pgTAP 013-016; this suite pins the API surface,
 * runs parallel claims through the HTTP layer, and walks one reminder from
 * schedule to a credited booking.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLocalClient,
  createLocalGarage,
  createLocalIdentity,
  getLocalSupabaseConfig,
  localRunId,
  type LocalTestGarage,
} from "../helpers/local-supabase";

type Job = {
  id: string;
  kind: string;
  garage_id: string | null;
  payload: Record<string, unknown>;
  dedupe_key: string | null;
  run_at: string;
  status: "queued" | "running" | "done" | "failed";
  attempts: number;
  max_attempts: number;
  locked_until: string | null;
  last_error: string | null;
};

type ClaimedReminder = {
  id: string;
  rule_id: string;
  kind: "mot" | "service" | "review";
  due_date: string;
  offset_days: number;
  send_at: string;
  channel: "sms" | "whatsapp" | "email";
  template: string;
  customer_id: string;
  customer_name: string;
  phone: string | null;
  email: string | null;
  vehicle_id: string;
  registration: string;
  make: string | null;
  model: string | null;
};

const config = getLocalSupabaseConfig();
const service = createLocalClient(config.secretKey);
/** Job kinds of this run only, so parallel suites and leftovers never mix. */
const kind = (name: string) => `it.${name}.r${localRunId}`;

/** A local calendar date in Europe/London, `days` from today. */
function londonDate(days: number) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(Date.now() + days * 86_400_000));
}

afterAll(async () => {
  // Platform jobs have no garage to cascade from; remove this run's.
  const removed = await service.from("jobs").delete().like("kind", `it.%.r${localRunId}`);
  if (removed.error) throw new Error(`Could not remove this run's jobs: ${removed.error.message}`);
});

describe("job queue RPCs", () => {
  it("enqueue_job returns the job, and the same dedupe key returns the same job", async () => {
    const dedupeKey = `it:${localRunId}:once`;
    const first = await service.rpc("enqueue_job", { p_kind: kind("enqueue"), p_payload: { n: 1 }, p_dedupe_key: dedupeKey });
    expect(first.error).toBeNull();
    const job = first.data as Job;
    expect(job).toMatchObject({ kind: kind("enqueue"), status: "queued", attempts: 0, max_attempts: 5, payload: { n: 1 }, garage_id: null });
    const again = await service.rpc("enqueue_job", { p_kind: kind("enqueue"), p_payload: { n: 2 }, p_dedupe_key: dedupeKey });
    expect(again.error).toBeNull();
    expect((again.data as Job).id).toBe(job.id);
    expect((again.data as Job).payload).toEqual({ n: 1 });
  });

  it("parallel claims never return the same job and never come back short", async () => {
    const jobKind = kind("parallel");
    const inserted = await service.from("jobs").insert(Array.from({ length: 40 }, (_, index) => ({
      kind: jobKind,
      payload: { index },
      run_at: new Date(Date.now() - (index + 1) * 1000).toISOString(),
    })));
    expect(inserted.error).toBeNull();

    const claims = await Promise.all(Array.from({ length: 8 }, () => service.rpc("claim_jobs", { p_kind: jobKind, p_limit: 5 })));
    for (const claim of claims) expect(claim.error).toBeNull();
    const batches = claims.map((claim) => (claim.data ?? []) as Job[]);
    // With FOR UPDATE SKIP LOCKED each worker takes 5 unclaimed rows at once;
    // a plain FOR UPDATE would make later workers wait and come back short.
    expect(batches.map((batch) => batch.length)).toEqual([5, 5, 5, 5, 5, 5, 5, 5]);
    const ids = batches.flat().map((job) => job.id);
    expect(new Set(ids).size).toBe(40);
    for (const job of batches.flat()) expect(job).toMatchObject({ status: "running", attempts: 1 });

    const more = await service.rpc("claim_jobs", { p_kind: jobKind, p_limit: 5 });
    expect(more.data).toEqual([]);
  });

  it("finish_job and fail_job report what happened", async () => {
    const jobKind = kind("outcome");
    await service.rpc("enqueue_job", { p_kind: jobKind });
    await service.rpc("enqueue_job", { p_kind: jobKind });
    const claimed = await service.rpc("claim_jobs", { p_kind: jobKind, p_limit: 2 });
    const [done, retried] = (claimed.data ?? []) as Job[];
    expect(done && retried).toBeTruthy();

    expect((await service.rpc("finish_job", { p_id: done!.id })).data).toBe(true);
    expect((await service.rpc("finish_job", { p_id: done!.id })).data).toBe(false);
    expect((await service.rpc("fail_job", { p_id: retried!.id, p_error: "PROVIDER_TIMEOUT" })).data).toBe("queued");
    expect((await service.rpc("fail_job", { p_id: retried!.id, p_error: "again" })).data).toBeNull();

    const row = await service.from("jobs").select("status, attempts, last_error, run_at").eq("id", retried!.id).single();
    expect(row.data).toMatchObject({ status: "queued", attempts: 1, last_error: "PROVIDER_TIMEOUT" });
    expect(new Date(String(row.data?.run_at)).getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  it("signed-in staff cannot use the queue", async () => {
    const identity = await createLocalIdentity(service, config.publishableKey, `queue-staff-${localRunId}@example.test`);
    const staff = createLocalClient(config.publishableKey, identity.accessToken);
    expect((await staff.rpc("claim_jobs", { p_kind: kind("enqueue"), p_limit: 1 })).error?.code).toBe("42501");
    expect((await staff.rpc("enqueue_job", { p_kind: kind("enqueue") })).error?.code).toBe("42501");
    expect((await staff.from("jobs").select("id")).error?.code).toBe("42501");
    expect((await staff.from("vehicle_facts").select("reg_hash")).error?.code).toBe("42501");
  });
});

describe("a reminder from schedule to a credited booking", () => {
  let garage: LocalTestGarage;
  const phone = "+447700916901";
  const registration = `RM${localRunId.slice(0, 5).toUpperCase()}`;
  let vehicleId: string;
  let customerId: string;

  beforeAll(async () => {
    garage = await createLocalGarage(service, "r");
    const motOn = await service.from("garages").update({ mot_enabled: true }).eq("id", garage.id);
    if (motOn.error) throw new Error(motOn.error.message);
    const defaults = await service.rpc("seed_garage_defaults", { p_garage_id: garage.id });
    if (defaults.error) throw new Error(defaults.error.message);
    expect(defaults.data).toEqual({ opening_hours: 6, resources: 4, services: 6, reminder_rules: 4 });

    const customer = await service.from("customers").insert({
      garage_id: garage.id,
      name: "Rita Reminded",
      phone,
      preferred_contact: "phone",
      channel: "sms",
      reminder_consent: true,
      consent_at: new Date().toISOString(),
      consent_source: "import",
    }).select("id").single();
    if (customer.error || !customer.data) throw new Error(customer.error?.message);
    customerId = customer.data.id;
    // MOT due in 7 days: the 7-day reminder's send day is today.
    const vehicle = await service.from("vehicles").insert({
      garage_id: garage.id,
      customer_id: customerId,
      registration,
      make: "Toyota",
      model: "Yaris",
      mot_expiry: londonDate(7),
    }).select("id").single();
    if (vehicle.error || !vehicle.data) throw new Error(vehicle.error?.message);
    vehicleId = vehicle.data.id;
  });

  it("schedules, claims, sends, books through the reminder and counts it as won back", async () => {
    const scheduled = await service.rpc("schedule_reminders", { p_garage_id: garage.id, p_today: londonDate(0) });
    expect(scheduled.error).toBeNull();
    expect(scheduled.data).toEqual({ mot: 1, service: 0, review: 0, cancelled: 0 });

    const send = await service.from("reminder_sends").select("id, send_at, status").eq("garage_id", garage.id).single();
    expect(send.data?.status).toBe("scheduled");

    // The sender claims it once its time has come (10:00 London today).
    const claimAt = new Date(new Date(String(send.data?.send_at)).getTime() + 60_000).toISOString();
    const claimed = await service.rpc("claim_reminder_sends", { p_garage_id: garage.id, p_now: claimAt, p_limit: 10 });
    expect(claimed.error).toBeNull();
    const reminders = (claimed.data ?? []) as ClaimedReminder[];
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({
      id: send.data?.id,
      kind: "mot",
      due_date: londonDate(7),
      offset_days: 7,
      channel: "sms",
      customer_id: customerId,
      customer_name: "Rita Reminded",
      phone,
      email: null,
      vehicle_id: vehicleId,
      registration,
      make: "Toyota",
      model: "Yaris",
    });
    expect(reminders[0]?.template).toContain("{link}");

    // The sender records the send (mock provider), as P3.7 will.
    const sent = await service.from("reminder_sends").update({
      status: "sent",
      sent_at: new Date().toISOString(),
      provider_msg_id: `SMit${localRunId}`,
      link_token_hash: "a".repeat(64),
      link_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      body: "Hi Rita, the MOT on your Toyota Yaris is due. Reply STOP to opt out.",
    }).eq("id", reminders[0]!.id);
    expect(sent.error).toBeNull();

    // The customer books through the link: same phone and car, the send id.
    const diagnostics = await service.from("services").select("id, price_pence").eq("garage_id", garage.id).eq("name", "Diagnostics").single();
    const slots = await service.rpc("available_slots", {
      p_garage_id: garage.id,
      p_service_id: diagnostics.data?.id,
      p_from: londonDate(1),
      p_to: londonDate(14),
    });
    const slot = ((slots.data ?? []) as { starts_at: string; free_count: number }[]).find((candidate) => candidate.free_count > 0);
    expect(slot).toBeTruthy();
    const booking = await service.rpc("create_booking", {
      p_garage_id: garage.id,
      p_booking: {
        service_id: diagnostics.data?.id,
        starts_at: slot!.starts_at,
        source: "online",
        idempotency_key: randomUUID(),
        reminder_send_id: reminders[0]!.id,
        customer: { name: "Rita Reminded", phone, channel: "sms" },
        vehicle: { registration },
      },
    });
    expect(booking.error).toBeNull();
    const bookingId = (booking.data as { booking_id: string }).booking_id;

    const stored = await service.from("bookings").select("source, reminder_send_id").eq("id", bookingId).single();
    expect(stored.data).toEqual({ source: "reminder", reminder_send_id: reminders[0]!.id });
    const credited = await service.from("reminder_sends").select("booking_id").eq("id", reminders[0]!.id).single();
    expect(credited.data?.booking_id).toBe(bookingId);

    const wonBack = await service.rpc("reminder_won_back", { p_garage_id: garage.id, p_from: londonDate(0), p_to: londonDate(0) });
    expect(wonBack.error).toBeNull();
    expect(wonBack.data).toEqual([{ sent: 1, bookings: 1, pence: diagnostics.data?.price_pence }]);
  });
});
