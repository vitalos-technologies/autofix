import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCustomersEnrichHandler } from "@/lib/jobs/handlers/customers-enrich";
import { createDomainsCheckHandler, createSupabaseDomainsCheckRepo } from "@/lib/jobs/handlers/domains-check";
import { createMessagesReplyHandler, helpReplyBody } from "@/lib/jobs/handlers/messages-reply";
import { createMotRefreshHandler } from "@/lib/jobs/handlers/mot-refresh";
import { createNotificationsBookingHandler } from "@/lib/jobs/handlers/notifications-booking";
import { remindersScheduleHandler } from "@/lib/jobs/handlers/reminders-schedule";
import { retentionHandler } from "@/lib/jobs/handlers/retention";
import { JobError } from "@/lib/jobs/types";
import { clearMockOutbox, createMockChannel, getMockOutbox } from "@/lib/messaging/mock";
import { createMockDomainsClient, DomainsError } from "@/lib/vercel/domains";
import { vehicleLookupError } from "@/lib/vehicle/provider";
import type { DvsaVehicle, MotHistoryLookup } from "@/lib/vehicle/dvsa";
import { createFakeSupabase, filterValue, hasFilter, type FakeQuery } from "./support/fake-supabase";
import { jobContext, jobRow, recordingQueue } from "./support/jobs";

// One test group per job handler (P3.7), against the fake Supabase client:
// what each reads and writes, what it queues next, and that payloads and
// results carry ids and counts only.

const A = "a0000000-0000-4000-8000-00000000000a";
const B = "b0000000-0000-4000-8000-00000000000b";
const NOW = new Date("2026-06-30T23:30:00Z");

async function expectJobError(promise: Promise<unknown>, code: string, retry: boolean) {
  const error = await promise.then(() => null, (thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(JobError);
  expect((error as JobError).code).toBe(code);
  expect((error as JobError).retry).toBe(retry);
}

describe("reminders.schedule", () => {
  it("fans out one job per active garage, keyed by the garage's own local day", async () => {
    const fake = createFakeSupabase({
      from: () => ({ data: [{ id: A, timezone: "Europe/London", mot_enabled: true, status: "active" }, { id: B, timezone: "America/New_York", mot_enabled: false, status: "onboarding" }] }),
    });
    const { queue, enqueued } = recordingQueue();
    const result = await remindersScheduleHandler({}, jobContext({ job: jobRow("reminders.schedule"), db: fake.client, now: NOW, queue }));
    expect(hasFilter(fake.queries[0]!, "in", "status", ["onboarding", "active"])).toBe(true);
    expect(enqueued).toEqual([
      { kind: "reminders.schedule", payload: { garageId: A }, options: { garageId: A, dedupeKey: `reminders.schedule:${A}:2026-07-01` } },
      { kind: "reminders.schedule", payload: { garageId: B }, options: { garageId: B, dedupeKey: `reminders.schedule:${B}:2026-06-30` } },
    ]);
    expect(result).toEqual({ outcome: "fanned_out", counts: { garages: 2 } });
  });

  it("runs schedule_reminders for the garage with its local today", async () => {
    const fake = createFakeSupabase({
      from: () => ({ data: { id: A, timezone: "Europe/London" } }),
      rpc: () => ({ data: { mot: 2, service: 1, review: 0, cancelled: 1 } }),
    });
    const result = await remindersScheduleHandler({ garageId: A }, jobContext({ job: jobRow("reminders.schedule", { garageId: A }, A), db: fake.client, now: NOW }));
    expect(fake.rpcs).toEqual([{ fn: "schedule_reminders", args: { p_garage_id: A, p_today: "2026-07-01" } }]);
    expect(result).toEqual({ outcome: "scheduled", counts: { mot: 2, service: 1, review: 0, cancelled: 1 } });
  });

  it("fails for good on a bad payload or a garage that is gone, and retries database errors", async () => {
    const empty = createFakeSupabase({ from: () => ({ data: null }) });
    await expectJobError(remindersScheduleHandler({ garageId: "not-a-uuid" }, jobContext({ job: jobRow("reminders.schedule"), db: empty.client, now: NOW })), "INVALID_PAYLOAD", false);
    await expectJobError(remindersScheduleHandler({ garageId: A, phone: "+447700900123" }, jobContext({ job: jobRow("reminders.schedule"), db: empty.client, now: NOW })), "INVALID_PAYLOAD", false);
    await expectJobError(remindersScheduleHandler({ garageId: A }, jobContext({ job: jobRow("reminders.schedule", { garageId: A }, B), db: empty.client, now: NOW })), "GARAGE_MISMATCH", false);
    await expectJobError(remindersScheduleHandler({ garageId: A }, jobContext({ job: jobRow("reminders.schedule", { garageId: A }, A), db: empty.client, now: NOW })), "GARAGE_NOT_FOUND", false);
    const broken = createFakeSupabase({ from: () => ({ data: { id: A, timezone: "Europe/London" } }), rpc: () => ({ error: { code: "57014", message: "canceling statement due to statement timeout" } }) });
    await expectJobError(remindersScheduleHandler({ garageId: A }, jobContext({ job: jobRow("reminders.schedule", { garageId: A }, A), db: broken.client, now: NOW })), "DATABASE_ERROR", true);
  });
});

describe("mot.refresh", () => {
  const today = new Date("2026-10-27T02:00:00Z");
  const vehicles = [
    { id: "00000000-0000-4000-8000-000000000101", registration: "MT26AAA", mot_expiry: "2026-11-10" },
    { id: "00000000-0000-4000-8000-000000000102", registration: "MT26BBB", mot_expiry: null },
    { id: "00000000-0000-4000-8000-000000000103", registration: "MT26CCC", mot_expiry: "2026-12-01" },
  ];

  function history(expiry: string): DvsaVehicle {
    return { mot: { motExpiry: expiry, motTests: [] } };
  }

  function motDb(options: { garage?: Record<string, unknown> | null; candidates?: typeof vehicles } = {}) {
    return createFakeSupabase({
      from: (query) => {
        if (query.table === "garages") {
          return query.single ? { data: options.garage === undefined ? { id: A, timezone: "Europe/London", mot_enabled: true, status: "active" } : options.garage } : { data: [{ id: A, timezone: "Europe/London", mot_enabled: true, status: "active" }] };
        }
        if (query.table === "vehicles" && query.operation === "select") return { data: options.candidates ?? vehicles };
        if (query.table === "reminder_sends") return { data: null, count: 2 };
        return { data: null };
      },
      rpc: () => ({ data: { mot: 1, service: 0, review: 0, cancelled: 0 } }),
    });
  }

  it("fans out only to active garages with MOT switched on", async () => {
    const fake = motDb();
    const { queue, enqueued } = recordingQueue();
    await createMotRefreshHandler({ lookup: () => null })({}, jobContext({ job: jobRow("mot.refresh"), db: fake.client, now: today, queue }));
    expect(hasFilter(fake.queries[0]!, "eq", "mot_enabled", true)).toBe(true);
    expect(enqueued).toEqual([{ kind: "mot.refresh", payload: { garageId: A }, options: { garageId: A, dedupeKey: `mot.refresh:${A}:2026-10-27` } }]);
  });

  it("picks consenting owners' cars that are due, unknown or stale, and not checked in the last 20 hours", async () => {
    const fake = motDb({ candidates: [] });
    const lookup: MotHistoryLookup = { getMotHistory: vi.fn() };
    await createMotRefreshHandler({ lookup: () => lookup })({ garageId: A }, jobContext({ job: jobRow("mot.refresh", { garageId: A }, A), db: fake.client, now: today }));
    const query = fake.queries.find((entry) => entry.table === "vehicles")!;
    expect(query.columns).toContain("customers!inner(reminder_consent,opted_out_at,anonymised_at)");
    expect(hasFilter(query, "eq", "garage_id", A)).toBe(true);
    expect(hasFilter(query, "eq", "customers.reminder_consent", true)).toBe(true);
    expect(hasFilter(query, "is", "customers.opted_out_at", null)).toBe(true);
    expect(hasFilter(query, "is", "customers.anonymised_at", null)).toBe(true);
    const or = query.filters.find((filter) => filter.method === "or")?.args[0];
    expect(or).toBe(
      "mot_checked_at.is.null,mot_checked_at.lt.2026-09-27T02:00:00.000Z,"
      + "and(mot_checked_at.lt.2026-10-26T06:00:00.000Z,or(mot_expiry.is.null,mot_expiry.lte.2026-12-26))",
    );
    expect(lookup.getMotHistory).not.toHaveBeenCalled();
  });

  it("updates a moved expiry, cancels the old date's pending MOT reminders, keeps unknown cars, and stops at a rate limit", async () => {
    const fake = motDb();
    const getMotHistory = vi.fn()
      .mockResolvedValueOnce(history("2027-11-10"))
      .mockRejectedValueOnce(vehicleLookupError("not_found", { source: "dvsa" }))
      .mockRejectedValueOnce(vehicleLookupError("rate_limited", { source: "dvsa", retryAfterMs: 30_000 }));
    const { queue, enqueued } = recordingQueue();
    const job = jobRow("mot.refresh", { garageId: A }, A);
    const result = await createMotRefreshHandler({ lookup: () => ({ getMotHistory }) })({ garageId: A }, jobContext({ job, db: fake.client, now: today, queue }));

    expect(getMotHistory.mock.calls.map((call) => call[0])).toEqual(["MT26AAA", "MT26BBB", "MT26CCC"]);
    const updates = fake.queries.filter((query) => query.table === "vehicles" && query.operation === "update");
    expect(updates.map((query) => [filterValue(query, "eq", "id"), query.values])).toEqual([
      [vehicles[0]!.id, { mot_checked_at: today.toISOString(), mot_expiry: "2027-11-10" }],
      [vehicles[1]!.id, { mot_checked_at: today.toISOString() }],
    ]);
    for (const update of updates) expect(filterValue(update, "eq", "garage_id")).toBe(A);

    const cancel = fake.queries.find((query) => query.table === "reminder_sends") as FakeQuery;
    expect(cancel.values).toEqual({ status: "cancelled", skip_reason: "due_date_changed" });
    expect(cancel.options).toEqual({ count: "exact" });
    expect(cancel.filters).toEqual(expect.arrayContaining([
      { method: "eq", args: ["garage_id", A] },
      { method: "eq", args: ["vehicle_id", vehicles[0]!.id] },
      { method: "eq", args: ["kind", "mot"] },
      { method: "eq", args: ["status", "scheduled"] },
      { method: "neq", args: ["due_date", "2027-11-10"] },
    ]));
    // New dates get their reminder rows straight away.
    expect(fake.rpcs).toEqual([{ fn: "schedule_reminders", args: { p_garage_id: A, p_today: "2026-10-27" } }]);
    // The rest waits for DVSA: from the last car handled, 30 s later.
    expect(enqueued).toEqual([{
      kind: "mot.refresh",
      payload: { garageId: A, after: vehicles[1]!.id },
      options: { garageId: A, runAt: new Date(today.getTime() + 30_000), dedupeKey: `mot.refresh:${A}:retry:${job.id}` },
    }]);
    expect(result).toEqual({ outcome: "rate_limited", counts: { candidates: 3, checked: 2, changed: 1, moved_forward: 1, cancelled: 2, not_found: 1, errors: 0, more: 1 } });
  });

  it("continues after a full batch, and does nothing while MOT is off or no MOT source is configured", async () => {
    const fake = motDb();
    const { queue, enqueued } = recordingQueue();
    const job = jobRow("mot.refresh", { garageId: A }, A);
    const lookup: MotHistoryLookup = { getMotHistory: async () => history("2026-12-01") };
    await createMotRefreshHandler({ lookup: () => lookup, batchSize: 3 })({ garageId: A }, jobContext({ job, db: fake.client, now: today, queue }));
    expect(enqueued).toEqual([{ kind: "mot.refresh", payload: { garageId: A, after: vehicles[2]!.id }, options: { garageId: A, dedupeKey: `mot.refresh:${A}:after:${job.id}` } }]);

    const off = motDb({ garage: { id: A, timezone: "Europe/London", mot_enabled: false, status: "active" } });
    expect(await createMotRefreshHandler({ lookup: () => lookup })({ garageId: A }, jobContext({ job, db: off.client, now: today }))).toEqual({ outcome: "mot_disabled" });
    const unconfigured = motDb();
    expect(await createMotRefreshHandler({ lookup: () => null })({ garageId: A }, jobContext({ job, db: unconfigured.client, now: today }))).toEqual({ outcome: "not_configured" });
    expect(unconfigured.queries.some((query) => query.table === "vehicles")).toBe(false);
  });
});

describe("domains.check", () => {
  const rows = [
    { id: "00000000-0000-4000-8000-000000000201", garage_id: A, hostname: "book.hartleyroad.co.uk", kind: "custom", status: "pending_dns", created_at: "2026-10-27T10:00:00Z", last_checked_at: null, verification: {} },
    { id: "00000000-0000-4000-8000-000000000202", garage_id: B, hostname: "book.ratelimit-garage.co.uk", kind: "custom", status: "pending_dns", created_at: "2026-10-26T09:00:00Z", last_checked_at: "2026-10-27T09:00:00Z", verification: { pending_since: "2026-10-27T08:00:00Z" } },
  ];

  it("lists due custom domains and writes each step back, scoped to its garage", async () => {
    const fake = createFakeSupabase({ from: (query) => (query.operation === "select" ? { data: rows } : { data: null }) });
    const repo = createSupabaseDomainsCheckRepo(fake.client);
    const listed = await repo.listDomainsToCheck(new Date());
    expect(listed.map((row) => row.pendingSince)).toEqual(["2026-10-27T10:00:00Z", "2026-10-27T08:00:00Z"]);
    const select = fake.queries[0]!;
    expect(select.filters).toEqual(expect.arrayContaining([
      { method: "eq", args: ["kind", "custom"] },
      { method: "in", args: ["status", ["pending_dns", "verifying"]] },
      { method: "is", args: ["deleted_at", null] },
    ]));
    await repo.updateDomainStatus(rows[1]!.id, { status: "verifying", error: null, lastCheckedAt: new Date("2026-10-27T11:00:00Z") });
    const update = fake.queries[1]!;
    expect(update.values).toEqual({ status: "verifying", error: null, last_checked_at: "2026-10-27T11:00:00.000Z" });
    expect(hasFilter(update, "eq", "garage_id", B)).toBe(true);
  });

  it("advances domains and queues a retry when Vercel rate-limits", async () => {
    const updates: Array<{ id: string; status: string }> = [];
    const repo = {
      listDomainsToCheck: async () => [
        { id: "d1", hostname: "book.hartleyroad.co.uk", garageId: A, kind: "custom" as const, status: "pending_dns" as const, pendingSince: new Date(), lastCheckedAt: null },
        { id: "d2", hostname: "book.ratelimit-garage.co.uk", garageId: B, kind: "custom" as const, status: "pending_dns" as const, pendingSince: new Date(), lastCheckedAt: null },
      ],
      updateDomainStatus: async (id: string, patch: { status: string }) => {
        updates.push({ id, status: patch.status });
      },
    };
    const { queue, enqueued } = recordingQueue();
    const now = new Date("2026-10-27T11:00:00Z");
    const job = jobRow("domains.check");
    const result = await createDomainsCheckHandler({ client: () => createMockDomainsClient(), repo: () => repo })({}, jobContext({ job, db: {} as never, now, queue }));
    expect(updates[0]?.id).toBe("d1");
    expect(result).toMatchObject({ outcome: "rate_limited", counts: { considered: 2, checked: 1 } });
    expect(enqueued).toEqual([{ kind: "domains.check", payload: {}, options: { runAt: new Date(now.getTime() + 60_000), dedupeKey: `domains.check:retry:${job.id}` } }]);
  });

  it("ends quietly when the Vercel integration is not configured", async () => {
    const lines: string[] = [];
    const result = await createDomainsCheckHandler({
      client: () => {
        throw new DomainsError("configuration_required", "Vercel domains live mode needs VERCEL_API_TOKEN.");
      },
    })({}, jobContext({ job: jobRow("domains.check"), db: {} as never, now: new Date(), lines }));
    expect(result).toEqual({ outcome: "configuration_required" });
    expect(lines.join("\n")).toContain("domains_not_configured");
  });
});

describe("retention", () => {
  it("fans out per garage (cancelled ones too), purges old vehicle facts and finished jobs, and clears old platform-line voicemails", async () => {
    const fake = createFakeSupabase({
      from: (query) => {
        if (query.table === "garages") return { data: [{ id: A, status: "active" }, { id: B, status: "cancelled" }] };
        return { data: null, count: query.table === "jobs" ? 7 : 3 };
      },
      rpc: () => ({ data: 2 }),
    });
    const { queue, enqueued } = recordingQueue();
    const now = new Date("2026-10-27T11:00:00Z");
    const result = await retentionHandler({}, jobContext({ job: jobRow("retention"), db: fake.client, now, queue }));
    expect(fake.queries[0]!.filters.some((filter) => filter.method === "in")).toBe(false);
    expect(enqueued.map((entry) => entry.options.dedupeKey)).toEqual([`retention:${A}:2026-10-27`, `retention:${B}:2026-10-27`]);

    const facts = fake.queries.find((query) => query.table === "vehicle_facts")!;
    expect(facts.operation).toBe("delete");
    expect(facts.filters).toEqual([{ method: "lt", args: ["fetched_at", "2026-09-27T11:00:00.000Z"] }]);
    const jobs = fake.queries.find((query) => query.table === "jobs")!;
    expect(jobs.operation).toBe("delete");
    expect(jobs.filters).toEqual([
      { method: "in", args: ["status", ["done", "failed"]] },
      { method: "lt", args: ["finished_at", "2026-10-13T11:00:00.000Z"] },
    ]);
    expect(fake.rpcs.map((call) => call.fn)).toEqual(["apply_platform_call_retention"]);
    expect(result).toEqual({ outcome: "fanned_out", counts: { garages: 2, vehicle_facts: 3, jobs: 7, platform_voicemails_cleared: 2 } });
  });

  it("runs enquiry and message retention for one garage and reports totals only", async () => {
    const fake = createFakeSupabase({ rpc: (call) => ({ data: call.fn === "apply_enquiry_retention" ? 2 : 5 }) });
    const result = await retentionHandler({ garageId: A }, jobContext({ job: jobRow("retention", { garageId: A }, A), db: fake.client, now: new Date() }));
    expect(fake.rpcs).toEqual([
      { fn: "apply_enquiry_retention", args: { p_garage_id: A } },
      { fn: "apply_message_retention", args: { p_garage_id: A } },
    ]);
    expect(result).toEqual({ outcome: "applied", counts: { anonymised: 2, messages_cleared: 5 } });
    expect(JSON.stringify(result)).not.toContain(A);
  });

  it("retries a garage whose retention failed", async () => {
    const fake = createFakeSupabase({ rpc: () => ({ error: { code: "40001", message: `garage ${A} failed` } }) });
    await expectJobError(retentionHandler({ garageId: A }, jobContext({ job: jobRow("retention", { garageId: A }, A), db: fake.client, now: new Date() })), "DATABASE_ERROR", true);
  });
});

describe("notifications.booking", () => {
  it("sends the booking's notifications with the job's client and counts the outcomes", async () => {
    const send = vi.fn(async () => [
      { kind: "customer_email" as const, status: "sent" as const },
      { kind: "staff_email" as const, status: "duplicate" as const },
      { kind: "sms" as const, status: "failed" as const, code: "invalid_recipient" },
    ]);
    const db = {} as never;
    const now = new Date("2026-10-27T11:00:00Z");
    const notice = { type: "rescheduled", garageId: A, bookingId: "00000000-0000-4000-8000-000000000301", previousStartsAt: "2026-11-02T10:00:00.000Z" };
    const result = await createNotificationsBookingHandler({ send })(notice, jobContext({ job: jobRow("notifications.booking", notice, A), db, now, env: { MESSAGING_MODE: "mock" } }));
    expect(send).toHaveBeenCalledWith(notice, { client: db, now, env: { MESSAGING_MODE: "mock" } });
    expect(result).toEqual({ outcome: "delivered", counts: { sent: 1, failed: 1, duplicate: 1, skipped: 0 } });
  });

  it("refuses a payload that is not a booking notice", async () => {
    await expectJobError(
      createNotificationsBookingHandler({ send: vi.fn() })({ type: "deleted", garageId: A, bookingId: A }, jobContext({ job: jobRow("notifications.booking"), db: {} as never, now: new Date() })),
      "INVALID_PAYLOAD",
      false,
    );
  });
});

describe("messages.reply (HELP)", () => {
  const inboundId = "00000000-0000-4000-8000-000000000401";
  const garageRow = { id: A, slug: "hartley-road", name: "Hartley Road Motors", phone: "+441302000101", email: "hello@hartleyroad.example", status: "active", garage_domains: [] };

  beforeEach(() => clearMockOutbox());

  function replyDb(recent: unknown[] = []) {
    return createFakeSupabase({
      from: (query) => {
        if (query.table === "garages") return { data: garageRow };
        if (query.table === "messages" && query.operation === "select" && query.single) {
          return { data: { id: inboundId, channel: "sms", direction: "inbound", from_address: "+447700900123", to_address: "+447700100200", customer_id: null } };
        }
        if (query.table === "messages" && query.operation === "select") return { data: recent };
        if (query.table === "messages" && query.operation === "insert") return { data: { id: "00000000-0000-4000-8000-000000000402" } };
        return { data: null };
      },
    });
  }

  it("answers with the garage's contact details and the opt-out line", () => {
    expect(helpReplyBody({ name: "Hartley Road Motors", phone: "+441302000101", email: "hello@hartleyroad.example" }, "sms"))
      .toMatch(/^Hartley Road Motors: for help, call .+ or email hello@hartleyroad\.example\. Reply STOP to opt out\.$/);
    expect(helpReplyBody({ name: "Demo Garage", phone: null, email: null }, "whatsapp")).toBe("Demo Garage: thanks for your message. We'll get back to you soon. Reply STOP to opt out.");
  });

  it("sends the answer to the sender through the mock channel and records it", async () => {
    const fake = replyDb();
    const payload = { garageId: A, inboundMessageId: inboundId, kind: "help" };
    const result = await createMessagesReplyHandler({ channelFor: (kind) => createMockChannel(kind) })(payload, jobContext({ job: jobRow("messages.reply", payload, A), db: fake.client, now: new Date() }));
    expect(result).toEqual({ outcome: "sent" });
    expect(getMockOutbox()).toEqual([expect.objectContaining({ kind: "sms", to: "+447700900123", idempotencyKey: `help_reply:${inboundId}` })]);
    const insert = fake.queries.find((query) => query.table === "messages" && query.operation === "insert")!;
    expect(insert.values).toMatchObject({ garage_id: A, direction: "outbound", to_address: "+447700900123", status: "sending", provider: "mock" });
    const update = fake.queries.find((query) => query.table === "messages" && query.operation === "update")!;
    expect(update.values).toMatchObject({ status: "queued", provider_msg_id: expect.stringMatching(/^SMmock/) });
  });

  it("does not answer the same number twice within 10 minutes", async () => {
    const fake = replyDb([{ id: "earlier" }]);
    const payload = { garageId: A, inboundMessageId: inboundId, kind: "help" };
    const result = await createMessagesReplyHandler({ channelFor: (kind) => createMockChannel(kind) })(payload, jobContext({ job: jobRow("messages.reply", payload, A), db: fake.client, now: new Date() }));
    expect(result).toEqual({ outcome: "already_answered" });
    expect(getMockOutbox()).toEqual([]);
  });
});

describe("customers.enrich (P3.11 import enrichment)", () => {
  const IMPORT = "00000000-0000-4000-8000-000000000501";
  const now = new Date("2026-10-27T11:00:00Z");
  const done = { checked: 10, enriched: 9, notFound: 1, failed: 0, remaining: false, stoppedReason: "done" as const };

  it("fans out once a day to garages with cars waiting", async () => {
    const fake = createFakeSupabase({ from: () => ({ data: [{ garage_id: A }, { garage_id: B }, { garage_id: A }] }) });
    const { queue, enqueued } = recordingQueue();
    const result = await createCustomersEnrichHandler({ enrich: vi.fn() })({}, jobContext({ job: jobRow("customers.enrich"), db: fake.client, now, queue }));
    expect(hasFilter(fake.queries[0]!, "eq", "enrichment_status", "pending")).toBe(true);
    expect(enqueued.map((entry) => [entry.payload, entry.options.dedupeKey])).toEqual([
      [{ garageId: A }, `customers.enrich:${A}:2026-10-27`],
      [{ garageId: B }, `customers.enrich:${B}:2026-10-27`],
    ]);
    expect(result).toEqual({ outcome: "fanned_out", counts: { garages: 2 } });
  });

  it("enriches one garage's import within the attempt's time, with the job's client", async () => {
    const enrich = vi.fn(async () => done);
    const db = {} as never;
    const { queue, enqueued } = recordingQueue();
    const result = await createCustomersEnrichHandler({ enrich })({ garageId: A, importId: IMPORT }, jobContext({ job: jobRow("customers.enrich", { garageId: A, importId: IMPORT }, A), db, now, queue, clock: () => 1_000, deadline: 16_000 }));
    expect(enrich).toHaveBeenCalledWith(expect.objectContaining({ garageId: A, importId: IMPORT, limit: 50, budgetMs: 15_000, client: db }));
    expect(enqueued).toEqual([]);
    expect(result).toEqual({ outcome: "done", counts: { checked: 10, enriched: 9, not_found: 1, failed: 0, more: 0 } });
  });

  it.each([
    ["a full batch: straight away", { ...done, remaining: true, stoppedReason: "limit" as const }, undefined, "more"],
    ["a DVSA rate limit: after Retry-After", { ...done, remaining: true, stoppedReason: "rate_limited" as const, retryAfterMs: 30_000 }, 30_000, "retry"],
    ["only failed lookups left: 15 minutes later", { ...done, failed: 2, remaining: true, stoppedReason: "done" as const }, 15 * 60_000, "retry"],
  ])("continues after %s", async (_label, outcome, delay, key) => {
    const { queue, enqueued } = recordingQueue();
    const job = jobRow("customers.enrich", { garageId: A }, A);
    await createCustomersEnrichHandler({ enrich: vi.fn(async () => outcome) })({ garageId: A }, jobContext({ job, db: {} as never, now, queue }));
    expect(enqueued).toEqual([{
      kind: "customers.enrich",
      payload: { garageId: A },
      options: { garageId: A, ...(delay ? { runAt: new Date(now.getTime() + delay) } : {}), dedupeKey: `customers.enrich:${A}:${key}:${job.id}` },
    }]);
  });

  it("stops quietly without a vehicle source and retries a database failure", async () => {
    const { queue, enqueued } = recordingQueue();
    const notConfigured = await createCustomersEnrichHandler({ enrich: vi.fn(async () => ({ ...done, remaining: true, stoppedReason: "not_configured" as const })) })({ garageId: A }, jobContext({ job: jobRow("customers.enrich", { garageId: A }, A), db: {} as never, now, queue }));
    expect(notConfigured).toMatchObject({ outcome: "not_configured" });
    expect(enqueued).toEqual([]);
    await expectJobError(
      createCustomersEnrichHandler({ enrich: vi.fn(async () => ({ ...done, remaining: true, stoppedReason: "error" as const })) })({ garageId: A }, jobContext({ job: jobRow("customers.enrich", { garageId: A }, A), db: {} as never, now })),
      "ENRICH_FAILED",
      true,
    );
  });
});
