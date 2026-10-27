/**
 * The reminder pipeline end to end against local Supabase (P3.7-P3.9):
 * reminders.schedule -> reminders.send (mock channel, mock outbox) -> Twilio
 * webhooks (STOP, START, HELP, delivery status) -> GET /r/{token} -> a booking
 * through the engine with the draft's reminderSendId -> attribution and
 * reminder_won_back(). Handlers run directly (not through drainJobs), so this
 * suite never claims jobs that belong to anything else in the shared local
 * database. QA's Gate 3 test builds on this.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createLocalClient, createLocalGarage, getLocalSupabaseConfig, localRunId, type LocalTestGarage } from "../helpers/local-supabase";

// Booking notifications have their own suites; the pipeline only needs the booking.
vi.mock("@/lib/booking-engine/notify", () => ({ notifyBooking: vi.fn(async () => undefined), bookingNoticeDedupeKey: () => "unused" }));

const configured = Boolean(process.env.INTEGRATION_SUPABASE_URL);

const AUTH_TOKEN = `integration-twilio-token-${localRunId}`;
const WEBHOOK_BASE = "https://autofix.integration.test";
const WEBHOOK_ENV = { TWILIO_AUTH_TOKEN: AUTH_TOKEN, TWILIO_WEBHOOK_BASE_URL: WEBHOOK_BASE };
const RITA = "+447700916921";
const OLLY = "+447700916922";
const NORA = "+447700916923";
const GARAGE_NUMBER = `+44113496${String(Number.parseInt(localRunId.slice(0, 6), 16) % 10_000).padStart(4, "0")}`;
const sid = (prefix: "SM" | "CA", n: number) => `${prefix}${localRunId}${String(n).padStart(4, "0")}`;

/** A London date `days` from today. */
function londonDate(days: number) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(Date.now() + days * 86_400_000));
}

/** The first Monday-to-Saturday London date at least `from` days ahead. */
function nextWorkingDay(from: number) {
  for (let days = from; days < from + 7; days += 1) {
    const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "Europe/London" }).format(new Date(Date.now() + days * 86_400_000));
    if (weekday !== "Sun") return { date: londonDate(days), days };
  }
  throw new Error("no working day");
}

function addDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

/** 10:01 London time on a date, as an instant (the reminder's send time is 10:00). */
function londonAt1001(date: string) {
  const guess = new Date(`${date}T10:01:00Z`);
  const local = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/London" }).format(guess);
  const offsetMinutes = (Number(local.slice(0, 2)) * 60 + Number(local.slice(3))) - (10 * 60 + 1);
  return new Date(guess.getTime() - offsetMinutes * 60_000);
}

describe.skipIf(!configured).sequential("reminder pipeline against local Supabase", () => {
  let service: SupabaseClient;
  let garage: LocalTestGarage;
  let target: { date: string; days: number };
  let sendNow: Date;
  const registrations = { rita: `RP${localRunId.slice(0, 5)}A`.toUpperCase(), olly: `RP${localRunId.slice(0, 5)}B`.toUpperCase(), nora: `RP${localRunId.slice(0, 5)}C`.toUpperCase() };
  const ids: Record<string, string> = {};

  // App modules, loaded after the env points at the local stack.
  let jobs: {
    schedule: typeof import("../../src/lib/jobs/handlers/reminders-schedule");
    send: typeof import("../../src/lib/jobs/handlers/reminders-send");
    reply: typeof import("../../src/lib/jobs/handlers/messages-reply");
    queue: typeof import("../../src/lib/jobs/queue");
    log: typeof import("../../src/lib/jobs/log");
    garages: typeof import("../../src/lib/jobs/garages");
  };
  let messaging: {
    mock: typeof import("../../src/lib/messaging/mock");
    twilio: typeof import("../../src/lib/messaging/twilio");
    webhooks: typeof import("../../src/lib/messaging/twilio-webhooks");
    repo: typeof import("../../src/lib/messaging/twilio-webhook-repository");
  };
  let links: { route: typeof import("../../src/lib/reminders/link-route"); open: typeof import("../../src/lib/reminders/open-link") };
  let state: typeof import("../../src/lib/booking-engine/state");
  let engineModule: typeof import("../../src/lib/booking-engine/repository");

  function context(job: { kind: string; payload: Record<string, unknown>; garageId: string | null }, now: Date) {
    return {
      job: { id: randomUUID(), kind: job.kind, garage_id: job.garageId, payload: job.payload, dedupe_key: null, run_at: now.toISOString(), status: "running" as const, attempts: 1, max_attempts: 5 },
      db: service,
      now: () => now,
      clock: Date.now,
      deadline: Date.now() + 15_000,
      queue: jobs.queue.createSupabaseJobQueue(service),
      log: jobs.log.createJobLogger({}, () => undefined),
      env: {},
    };
  }

  function webhook(kind: "sms" | "status" | "voice", params: Record<string, string>) {
    const body = new URLSearchParams(params).toString();
    const path = `/api/webhooks/twilio/${kind}`;
    const signature = messaging.twilio.computeTwilioSignature(`${WEBHOOK_BASE}${path}`, new URLSearchParams(body), AUTH_TOKEN);
    const request = new Request(`http://localhost:3000${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
      body,
    });
    return messaging.webhooks.handleTwilioWebhook(request, kind, {
      repo: () => messaging.repo.createSupabaseTwilioWebhookRepo(service),
      env: WEBHOOK_ENV,
      log: jobs.log.createJobLogger({}, () => undefined),
    });
  }

  beforeAll(async () => {
    const config = getLocalSupabaseConfig();
    process.env.NEXT_PUBLIC_SUPABASE_URL = config.url;
    process.env.SUPABASE_SECRET_KEY = config.secretKey;
    process.env.BOOKING_MANAGEMENT_SECRET = "integration-booking-management-secret-0123456789";
    process.env.MESSAGING_MODE = "mock";
    service = createLocalClient(config.secretKey);

    jobs = {
      schedule: await import("../../src/lib/jobs/handlers/reminders-schedule"),
      send: await import("../../src/lib/jobs/handlers/reminders-send"),
      reply: await import("../../src/lib/jobs/handlers/messages-reply"),
      queue: await import("../../src/lib/jobs/queue"),
      log: await import("../../src/lib/jobs/log"),
      garages: await import("../../src/lib/jobs/garages"),
    };
    messaging = {
      mock: await import("../../src/lib/messaging/mock"),
      twilio: await import("../../src/lib/messaging/twilio"),
      webhooks: await import("../../src/lib/messaging/twilio-webhooks"),
      repo: await import("../../src/lib/messaging/twilio-webhook-repository"),
    };
    links = { route: await import("../../src/lib/reminders/link-route"), open: await import("../../src/lib/reminders/open-link") };
    state = await import("../../src/lib/booking-engine/state");
    engineModule = await import("../../src/lib/booking-engine/repository");

    garage = await createLocalGarage(service, "rp");
    const motOn = await service.from("garages").update({ mot_enabled: true }).eq("id", garage.id);
    if (motOn.error) throw new Error(motOn.error.message);
    const defaults = await service.rpc("seed_garage_defaults", { p_garage_id: garage.id });
    if (defaults.error) throw new Error(defaults.error.message);
    const number = await service.from("garage_phone_numbers").insert({ garage_id: garage.id, number: GARAGE_NUMBER, purpose: "messaging", provider_sid: `PN${localRunId}` });
    if (number.error) throw new Error(`Could not provision the garage number: ${number.error.message}`);

    // The 7-day MOT reminder's send day is the next working day (Mon-Sat) after today.
    target = nextWorkingDay(1);
    sendNow = londonAt1001(target.date);
    const expiry = addDays(target.date, 7);
    const consent = { reminder_consent: true, consent_at: new Date().toISOString(), consent_source: "import" };
    const customers = await service.from("customers").insert([
      { garage_id: garage.id, name: "Rita Reminded", phone: RITA, preferred_contact: "phone", channel: "sms", ...consent },
      { garage_id: garage.id, name: "Olly Optout", phone: OLLY, preferred_contact: "phone", channel: "sms", ...consent },
      { garage_id: garage.id, name: "Nora Noconsent", phone: NORA, preferred_contact: "phone", channel: "sms", reminder_consent: false },
    ]).select("id,phone");
    if (customers.error || !customers.data) throw new Error(customers.error?.message);
    for (const row of customers.data as Array<{ id: string; phone: string }>) ids[row.phone] = row.id;

    const vehicles = await service.from("vehicles").insert([
      { garage_id: garage.id, customer_id: ids[RITA], registration: registrations.rita, make: "Toyota", model: "Yaris", mot_expiry: expiry },
      { garage_id: garage.id, customer_id: ids[OLLY], registration: registrations.olly, make: "Kia", model: "Picanto", mot_expiry: expiry },
      { garage_id: garage.id, customer_id: ids[NORA], registration: registrations.nora, make: "Fiat", model: "Panda", mot_expiry: expiry },
    ]).select("id,registration");
    if (vehicles.error || !vehicles.data) throw new Error(vehicles.error?.message);
    for (const row of vehicles.data as Array<{ id: string; registration: string }>) ids[row.registration] = row.id;
  }, 60_000);

  afterAll(async () => {
    if (!service || !garage) return;
    // Platform rows have no garage to cascade from; the number is unique across garages.
    await service.from("twilio_webhook_events").delete().like("provider_sid", `%${localRunId}%`);
    await service.from("jobs").delete().eq("garage_id", garage.id);
    await service.from("garage_phone_numbers").delete().eq("garage_id", garage.id);
  });

  let sendId: string;
  let token: string;

  it("schedules reminders only for customers with consent", async () => {
    const result = await jobs.schedule.remindersScheduleHandler({ garageId: garage.id }, context({ kind: "reminders.schedule", payload: { garageId: garage.id }, garageId: garage.id }, new Date()));
    expect(result).toEqual({ outcome: "scheduled", counts: { mot: 2, service: 0, review: 0, cancelled: 0 } });
    const rows = await service.from("reminder_sends").select("id,customer_id,status,offset_days").eq("garage_id", garage.id);
    expect((rows.data ?? []).map((row) => row.customer_id).sort()).toEqual([ids[RITA], ids[OLLY]].sort());
    sendId = (rows.data ?? []).find((row) => row.customer_id === ids[RITA])!.id;
  });

  it("STOP by text opts the customer out at once and cancels their scheduled reminder; a replay changes nothing", async () => {
    const stop = { MessageSid: sid("SM", 1), From: OLLY, To: GARAGE_NUMBER, Body: "STOP", NumMedia: "0" };
    expect((await webhook("sms", stop)).status).toBe(200);
    expect((await webhook("sms", stop)).status).toBe(200);

    const olly = await service.from("customers").select("opted_out_at").eq("id", ids[OLLY]!).single();
    expect(olly.data?.opted_out_at).toBeTruthy();
    // The same audited opt-out as the unsubscribe page (P4.9), once.
    const audit = await service.from("admin_audit_log").select("action,detail").eq("garage_id", garage.id).eq("entity_id", ids[OLLY]!);
    expect(audit.data).toEqual([{ action: "customer.opted_out", detail: { source: "sms_stop" } }]);
    const send = await service.from("reminder_sends").select("status,skip_reason").eq("garage_id", garage.id).eq("customer_id", ids[OLLY]!).single();
    expect(send.data).toEqual({ status: "cancelled", skip_reason: "opted_out" });
    const inbound = await service.from("messages").select("direction,status,from_address,customer_id,body").eq("garage_id", garage.id).eq("provider_msg_id", sid("SM", 1));
    expect(inbound.data).toEqual([{ direction: "inbound", status: "received", from_address: OLLY, customer_id: ids[OLLY], body: "STOP" }]);
    const events = await service.from("twilio_webhook_events").select("processing_status,outcome,attempts").eq("event_key", `inbound:${sid("SM", 1)}`).single();
    expect(events.data).toEqual({ processing_status: "processed", outcome: "stop", attempts: 1 });
  });

  it("sends the due reminder through the mock channel, skipping the opted-out customer", async () => {
    messaging.mock.clearMockOutbox();
    const handler = jobs.send.createRemindersSendHandler();
    const result = await handler({ garageId: garage.id }, context({ kind: "reminders.send", payload: { garageId: garage.id }, garageId: garage.id }, sendNow));
    expect(result).toMatchObject({ outcome: "sent", counts: { claimed: 1, sent: 1, failed: 0, refused: 0 } });

    const outbox = messaging.mock.getMockOutbox().filter((entry) => entry.garageId === garage.id);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ kind: "sms", to: RITA, idempotencyKey: `reminder_send:${sendId}` });
    // The one-text default wording (A184) and a 22-character link token (A185).
    expect(outbox[0]!.body).toMatch(/^.+: Hi Rita, MOT due \d{1,2} [A-Z][a-z]{2}\. Book: http:\/\/.+\/r\/[A-Za-z0-9_-]{22}\nReply STOP to opt out\.$/);
    token = /\/r\/([A-Za-z0-9_-]{22})\n/.exec(outbox[0]!.body)![1]!;

    const send = await service.from("reminder_sends").select("status,provider_msg_id,link_token_hash,link_expires_at,sent_at,body").eq("id", sendId).single();
    expect(send.data).toMatchObject({ status: "sent", provider_msg_id: outbox[0]!.providerMessageId, body: outbox[0]!.body });
    expect(send.data?.link_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(String(send.data?.sent_at)).getTime()).toBe(sendNow.getTime());
    expect(new Date(String(send.data?.link_expires_at)).getTime()).toBe(sendNow.getTime() + 30 * 86_400_000);
    const message = await service.from("messages").select("direction,status,to_address,provider,reminder_send_id,customer_id").eq("provider_msg_id", outbox[0]!.providerMessageId).single();
    expect(message.data).toEqual({ direction: "outbound", status: "queued", to_address: RITA, provider: "mock", reminder_send_id: sendId, customer_id: ids[RITA] });

    // Nothing more is due: a second run sends nothing.
    const again = await handler({ garageId: garage.id }, context({ kind: "reminders.send", payload: { garageId: garage.id }, garageId: garage.id }, sendNow));
    expect(again).toMatchObject({ counts: { claimed: 0, sent: 0 } });
  });

  it("moves the reminder forward on delivery receipts, never back", async () => {
    const providerId = (await service.from("reminder_sends").select("provider_msg_id").eq("id", sendId).single()).data!.provider_msg_id as string;
    expect((await webhook("status", { MessageSid: providerId, MessageStatus: "delivered", To: RITA })).status).toBe(200);
    expect((await webhook("status", { MessageSid: providerId, MessageStatus: "sent", To: RITA })).status).toBe(200);
    expect((await service.from("reminder_sends").select("status").eq("id", sendId).single()).data?.status).toBe("delivered");
    expect((await service.from("messages").select("status").eq("provider_msg_id", providerId).single()).data?.status).toBe("delivered");
  });

  it("START lifts an opt-out only with consent, and HELP queues an answer that goes out", async () => {
    await webhook("sms", { MessageSid: sid("SM", 2), From: OLLY, To: GARAGE_NUMBER, Body: "start", NumMedia: "0" });
    expect((await service.from("customers").select("opted_out_at").eq("id", ids[OLLY]!).single()).data?.opted_out_at).toBeNull();

    await webhook("sms", { MessageSid: sid("SM", 3), From: NORA, To: GARAGE_NUMBER, Body: "STOP", NumMedia: "0" });
    await webhook("sms", { MessageSid: sid("SM", 4), From: NORA, To: GARAGE_NUMBER, Body: "START", NumMedia: "0" });
    expect((await service.from("customers").select("opted_out_at").eq("id", ids[NORA]!).single()).data?.opted_out_at).toBeTruthy();

    await webhook("sms", { MessageSid: sid("SM", 5), From: NORA, To: GARAGE_NUMBER, Body: "Help", NumMedia: "0" });
    const inbound = (await service.from("messages").select("id").eq("provider_msg_id", sid("SM", 5)).single()).data!.id as string;
    const queued = await service.from("jobs").select("kind,status,garage_id,payload").eq("dedupe_key", `messages.reply:help:${inbound}`).single();
    expect(queued.data).toEqual({ kind: "messages.reply", status: "queued", garage_id: garage.id, payload: { garageId: garage.id, inboundMessageId: inbound, kind: "help" } });

    messaging.mock.clearMockOutbox();
    const payload = queued.data!.payload as Record<string, unknown>;
    expect(await jobs.reply.messagesReplyHandler(payload, context({ kind: "messages.reply", payload, garageId: garage.id }, new Date()))).toEqual({ outcome: "sent" });
    const [reply] = messaging.mock.getMockOutbox();
    expect(reply).toMatchObject({ to: NORA, body: expect.stringMatching(/^Integration Garage RP .+: for help, call .+\. Reply STOP to opt out\.$/) });
  });

  it("logs a call to the garage's number and answers with TwiML", async () => {
    const response = await webhook("voice", { CallSid: sid("CA", 1), From: RITA, To: GARAGE_NUMBER, CallStatus: "ringing", Direction: "inbound" });
    expect(await response.text()).toContain("<Say");
    const call = await service.from("calls").select("garage_id,from_number,to_number,status,missed").eq("provider_call_sid", sid("CA", 1)).single();
    expect(call.data).toEqual({ garage_id: garage.id, from_number: RITA, to_number: GARAGE_NUMBER, status: "ringing", missed: true });
  });

  it("opens /r/{token} into a prefilled draft, books through the engine and credits the reminder", async () => {
    const profile = await jobs.garages.loadJobGarage(service, garage.id);
    const response = await links.route.handleReminderLinkRequest(
      new Request(`http://${garage.slug}.localhost:3000/r/${token}`, { headers: { "x-forwarded-for": "198.51.100.21" } }),
      { garageId: garage.id, token },
      { hostGarage: async () => profile, repo: () => links.open.createSupabaseReminderLinkRepo(service), rateLimit: async () => true },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/time");
    const cookie = /af_booking=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
    const { draft } = state.openBookingSession(garage.id, decodeURIComponent(cookie ?? ""));
    const mot = await service.from("services").select("id,price_pence").eq("garage_id", garage.id).eq("is_mot", true).single();
    expect(draft).toMatchObject({ reminderSendId: sendId, serviceId: mot.data?.id, locationMode: "workshop", vehicle: { registration: registrations.rita, make: "Toyota", model: "Yaris" } });
    expect((await service.from("reminder_sends").select("opened_at").eq("id", sendId).single()).data?.opened_at).toBeTruthy();

    const engine = engineModule.createSupabaseBookingEngine({ client: () => service });
    const slots = await engine.getAvailableSlots({ garageId: garage.id, serviceId: draft.serviceId!, from: londonDate(1), to: londonDate(10) });
    const slot = slots.find((candidate) => candidate.freeCount > 0);
    expect(slot).toBeTruthy();
    const booked = await engine.createBooking(garage.id, {
      serviceId: draft.serviceId!,
      startsAt: slot!.startsAt,
      locationMode: draft.locationMode!,
      symptoms: [],
      customer: { name: "Rita Reminded", phone: "07700 916921", channel: "sms", reminderConsent: false },
      vehicle: { registration: draft.vehicle!.registration, make: draft.vehicle!.make, model: draft.vehicle!.model },
      idempotencyKey: draft.idempotencyKey!,
      source: "online",
      reminderSendId: draft.reminderSendId,
    });
    expect(booked).toMatchObject({ ok: true });
    if (!booked.ok) throw new Error(booked.code);

    const booking = await service.from("bookings").select("source,reminder_send_id").eq("id", booked.booking.id).single();
    expect(booking.data).toEqual({ source: "reminder", reminder_send_id: sendId });
    expect((await service.from("reminder_sends").select("booking_id").eq("id", sendId).single()).data?.booking_id).toBe(booked.booking.id);

    const wonBack = await service.rpc("reminder_won_back", { p_garage_id: garage.id, p_from: londonDate(0), p_to: target.date });
    expect(wonBack.error).toBeNull();
    expect(wonBack.data).toEqual([{ sent: 1, bookings: 1, pence: mot.data?.price_pence ?? 0 }]);
  });

  it("an expired or unknown link opens nothing", async () => {
    await service.from("reminder_sends").update({ link_expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", sendId);
    const profile = await jobs.garages.loadJobGarage(service, garage.id);
    const deps = { hostGarage: async () => profile, repo: () => links.open.createSupabaseReminderLinkRepo(service), rateLimit: async () => true };
    const expired = await links.route.handleReminderLinkRequest(new Request(`http://x.localhost:3000/r/${token}`), { garageId: garage.id, token }, deps);
    expect(expired.headers.get("location")).toBe("/r?link=expired");
    const unknownToken = "A".repeat(43);
    const unknown = await links.route.handleReminderLinkRequest(new Request(`http://x.localhost:3000/r/${unknownToken}`), { garageId: garage.id, token: unknownToken }, deps);
    expect(unknown.headers.get("location")).toBe("/r?link=invalid");
  });
});

describe.skipIf(!configured).sequential("mot.refresh against local Supabase", () => {
  let service: SupabaseClient;
  let garage: LocalTestGarage;
  let handlers: typeof import("../../src/lib/jobs/handlers/mot-refresh");
  let queueModule: typeof import("../../src/lib/jobs/queue");
  let logModule: typeof import("../../src/lib/jobs/log");
  const reg = (suffix: string) => `RM${localRunId.slice(0, 5)}${suffix}`.toUpperCase();
  const vehicleIds: Record<string, string> = {};

  beforeAll(async () => {
    const config = getLocalSupabaseConfig();
    process.env.NEXT_PUBLIC_SUPABASE_URL = config.url;
    process.env.SUPABASE_SECRET_KEY = config.secretKey;
    service = createLocalClient(config.secretKey);
    handlers = await import("../../src/lib/jobs/handlers/mot-refresh");
    queueModule = await import("../../src/lib/jobs/queue");
    logModule = await import("../../src/lib/jobs/log");

    garage = await createLocalGarage(service, "rm");
    await service.from("garages").update({ mot_enabled: true }).eq("id", garage.id);
    await service.rpc("seed_garage_defaults", { p_garage_id: garage.id });
    const consent = { reminder_consent: true, consent_at: new Date().toISOString(), consent_source: "import" };
    const customers = await service.from("customers").insert([
      { garage_id: garage.id, name: "Due Soon", phone: "+447700916931", preferred_contact: "phone", ...consent },
      { garage_id: garage.id, name: "No Consent", phone: "+447700916932", preferred_contact: "phone", reminder_consent: false },
      { garage_id: garage.id, name: "Opted Out", phone: "+447700916933", preferred_contact: "phone", ...consent, opted_out_at: new Date().toISOString() },
    ]).select("id,name");
    if (customers.error || !customers.data) throw new Error(customers.error?.message);
    const byName = Object.fromEntries((customers.data as Array<{ id: string; name: string }>).map((row) => [row.name, row.id]));
    const in20 = londonDate(20);
    const in200 = londonDate(200);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const rows = [
      { key: "due", customer_id: byName["Due Soon"], registration: reg("A"), mot_expiry: in20, mot_checked_at: yesterday },
      { key: "unknown", customer_id: byName["Due Soon"], registration: reg("B"), mot_expiry: null, mot_checked_at: null },
      { key: "far_fresh", customer_id: byName["Due Soon"], registration: reg("C"), mot_expiry: in200, mot_checked_at: yesterday },
      { key: "checked_recently", customer_id: byName["Due Soon"], registration: reg("D"), mot_expiry: in20, mot_checked_at: hourAgo },
      { key: "no_consent", customer_id: byName["No Consent"], registration: reg("E"), mot_expiry: in20, mot_checked_at: null },
      { key: "opted_out", customer_id: byName["Opted Out"], registration: reg("F"), mot_expiry: in20, mot_checked_at: null },
    ];
    const inserted = await service.from("vehicles").insert(rows.map((row) => ({
      garage_id: garage.id,
      customer_id: row.customer_id,
      registration: row.registration,
      mot_expiry: row.mot_expiry,
      mot_checked_at: row.mot_checked_at,
    }))).select("id,registration");
    if (inserted.error || !inserted.data) throw new Error(inserted.error?.message);
    for (const row of rows) vehicleIds[row.key] = (inserted.data as Array<{ id: string; registration: string }>).find((entry) => entry.registration === row.registration)!.id;
    // The due car's 7-day reminder is scheduled for its current expiry (its send day is 13 days ahead).
    const scheduled = await service.rpc("schedule_reminders", { p_garage_id: garage.id, p_today: londonDate(13) });
    if (scheduled.error) throw new Error(scheduled.error.message);
  }, 60_000);

  afterAll(async () => {
    if (service && garage) await service.from("jobs").delete().eq("garage_id", garage.id);
  });

  it("checks only consenting owners' cars that are due, unknown or stale, and moves a changed expiry with its reminders", async () => {
    const before = await service.from("reminder_sends").select("id,status").eq("garage_id", garage.id).eq("vehicle_id", vehicleIds.due!);
    expect(before.data?.map((row) => row.status)).toEqual(["scheduled"]);

    const looked: string[] = [];
    const newExpiry = londonDate(385);
    const handler = handlers.createMotRefreshHandler({
      lookup: () => ({
        async getMotHistory(registration: string) {
          looked.push(registration);
          return { mot: { motExpiry: registration === reg("A") ? newExpiry : undefined, motTests: [] } };
        },
      }),
    });
    const now = new Date();
    const result = await handler({ garageId: garage.id }, {
      job: { id: randomUUID(), kind: "mot.refresh", garage_id: garage.id, payload: { garageId: garage.id }, dedupe_key: null, run_at: now.toISOString(), status: "running", attempts: 1, max_attempts: 5 },
      db: service,
      now: () => now,
      clock: Date.now,
      deadline: Date.now() + 15_000,
      queue: queueModule.createSupabaseJobQueue(service),
      log: logModule.createJobLogger({}, () => undefined),
      env: {},
    });

    expect(looked.sort()).toEqual([reg("A"), reg("B")].sort());
    expect(result).toMatchObject({ outcome: "refreshed", counts: { candidates: 2, checked: 2, changed: 1, moved_forward: 1, cancelled: 1 } });
    const due = await service.from("vehicles").select("mot_expiry,mot_checked_at").eq("id", vehicleIds.due!).single();
    expect(due.data?.mot_expiry).toBe(newExpiry);
    expect(new Date(String(due.data?.mot_checked_at)).getTime()).toBe(now.getTime());
    const unknown = await service.from("vehicles").select("mot_expiry,mot_checked_at").eq("id", vehicleIds.unknown!).single();
    expect(unknown.data?.mot_expiry).toBeNull();
    expect(unknown.data?.mot_checked_at).toBeTruthy();
    const after = await service.from("reminder_sends").select("status,skip_reason").eq("id", before.data![0]!.id).single();
    expect(after.data).toEqual({ status: "cancelled", skip_reason: "due_date_changed" });
  });
});
