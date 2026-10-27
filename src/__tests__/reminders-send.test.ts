import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRemindersSendHandler } from "@/lib/jobs/handlers/reminders-send";
import { JobError } from "@/lib/jobs/types";
import type { ChannelKind, MessageChannel, SendResult } from "@/lib/messaging/channel";
import { clearMockOutbox, createMockChannel, getMockOutbox } from "@/lib/messaging/mock";
import type { ClaimedReminder } from "@/lib/reminders/compose";
import { REMINDER_LINK_TTL_MS } from "@/lib/reminders/link-token";
import { sendGarageReminders, sendWindow, type ReminderSendGarage, type ReminderSendRepo } from "@/lib/reminders/send";
import { createFakeSupabase } from "./support/fake-supabase";
import { jobContext, jobRow, recordingQueue } from "./support/jobs";

// reminders.send (P3.7): the send window in the garage's time zone (Sunday,
// evenings and both 2026 clock changes), what goes into each message (link
// token, opt-out line, placeholders), and what happens on each kind of
// provider result (A14: ambiguous sends are never retried).

const GARAGE_ID = "a0000000-0000-4000-8000-00000000000a";
const TUESDAY_11 = new Date("2026-10-27T11:00:00Z");
const PROD_ENV = { NODE_ENV: "production", NEXT_PUBLIC_TENANT_ROOT_DOMAIN: "autofix.vitalos.co.uk" };

const garage: ReminderSendGarage = { id: GARAGE_ID, slug: "hartley-road", customDomain: null, name: "Hartley Road Motors", timezone: "Europe/London", status: "active" };

let sequence = 0;
function reminder(overrides: Partial<ClaimedReminder> = {}): ClaimedReminder {
  sequence += 1;
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    rule_id: "00000000-0000-4000-8000-0000000000c9",
    kind: "mot",
    due_date: "2026-11-10",
    offset_days: 28,
    send_at: "2026-10-13T09:00:00Z",
    channel: "sms",
    template: "Hi {first_name}, the MOT on your {vehicle} ({reg}) is due on {due_date}. Book a time: {link}\n{garage}.",
    customer_id: "00000000-0000-4000-8000-0000000000c1",
    customer_name: "Sam Driver",
    phone: "+447700900123",
    email: "sam@example.com",
    vehicle_id: "00000000-0000-4000-8000-0000000000e1",
    registration: "AB12CDE",
    make: "Ford",
    model: "Focus",
    ...overrides,
  };
}

function fakeRepo(batches: ClaimedReminder[][]) {
  const calls = {
    claims: [] as Array<{ garageId: string; now: string; limit: number }>,
    prepared: [] as Array<{ id: string; linkHash: string; linkExpiresAt: Date; body: string; to: string; provider: string }>,
    sent: [] as Array<{ id: string; messageId: string; providerMessageId: string; status: string }>,
    failed: [] as Array<{ id: string; messageId: string | null; code: string }>,
    released: [] as Array<{ ids: string[]; messageIds: string[] }>,
    optOuts: [] as string[],
  };
  const queue = [...batches];
  const repo: ReminderSendRepo = {
    claim: vi.fn(async (garageId, now, limit) => {
      calls.claims.push({ garageId, now: now.toISOString(), limit });
      return queue.shift() ?? [];
    }),
    prepare: vi.fn(async (_garageId, row, prepared) => {
      calls.prepared.push({ id: row.id, ...prepared });
      return { messageId: `message-${row.id}` };
    }),
    markSent: vi.fn(async (_garageId, id, messageId, result) => {
      calls.sent.push({ id, messageId, ...result });
    }),
    markFailed: vi.fn(async (_garageId, id, messageId, code) => {
      calls.failed.push({ id, messageId, code });
    }),
    release: vi.fn(async (_garageId, ids, messageIds) => {
      calls.released.push({ ids, messageIds });
    }),
    optOut: vi.fn(async (_garageId, phone) => {
      calls.optOuts.push(phone);
    }),
  };
  return { repo, calls };
}

function channelReturning(...results: SendResult[]): (kind: ChannelKind) => MessageChannel {
  const send = vi.fn(async () => results.shift() ?? { ok: true as const, providerMessageId: "SMfallback", status: "queued" as const });
  return (kind) => ({ kind, mode: "live", send });
}

async function run(batches: ClaimedReminder[][], options: { now?: Date; channelFor?: (kind: ChannelKind) => MessageChannel; deadline?: number; clock?: () => number; env?: Record<string, string>; batchSize?: number } = {}) {
  const { repo, calls } = fakeRepo(batches);
  const result = await sendGarageReminders({
    garage,
    repo,
    channelFor: options.channelFor ?? ((kind) => createMockChannel(kind)),
    now: () => options.now ?? TUESDAY_11,
    deadline: options.deadline ?? Number.MAX_SAFE_INTEGER,
    clock: options.clock ?? (() => 0),
    env: options.env ?? PROD_ENV,
    batchSize: options.batchSize ?? 10,
  });
  return { result, calls };
}

beforeEach(() => {
  clearMockOutbox();
});

describe("send window (09:00-19:00 Mon-Sat, garage time zone)", () => {
  it.each([
    ["a weekday morning before 09:00 (GMT)", "2026-10-27T08:30:00Z", "2026-10-27T09:00:00.000Z"],
    ["Sunday, after BST ended", "2026-11-01T12:00:00Z", "2026-11-02T09:00:00.000Z"],
    ["Sunday 29 March 2026, the day BST starts", "2026-03-29T10:00:00Z", "2026-03-30T08:00:00.000Z"],
    ["Sunday 25 October 2026, the day BST ends", "2026-10-25T10:00:00Z", "2026-10-26T09:00:00.000Z"],
    ["Saturday evening before BST starts", "2026-03-28T19:30:00Z", "2026-03-30T08:00:00.000Z"],
    ["Saturday 19:30 BST before BST ends", "2026-10-24T18:30:00Z", "2026-10-26T09:00:00.000Z"],
    ["a weekday at 19:00 BST", "2026-06-30T18:00:00Z", "2026-07-01T08:00:00.000Z"],
  ])("defers %s to the next window", (_label, at, next) => {
    expect(sendWindow(new Date(at), "Europe/London")).toEqual({ open: false, next: new Date(next) });
  });

  it.each([
    ["Saturday 18:30 BST, the day before BST ends", "2026-10-24T17:30:00Z"],
    ["Monday 09:00 BST after BST starts", "2026-03-30T08:00:00Z"],
    ["Monday 09:00 GMT after BST ends", "2026-10-26T09:00:00Z"],
    ["a weekday 18:59 GMT", "2026-10-27T18:59:00Z"],
  ])("sends on %s", (_label, at) => {
    expect(sendWindow(new Date(at), "Europe/London")).toEqual({ open: true });
  });

  it("claims nothing outside the window", async () => {
    const { result, calls } = await run([[reminder()]], { now: new Date("2026-11-01T12:00:00Z") });
    expect(result).toMatchObject({ outcome: "deferred", deferUntil: new Date("2026-11-02T09:00:00.000Z") });
    expect(calls.claims).toEqual([]);
  });

  it("re-queues the garage's job for when the window opens (one job per window)", async () => {
    const { queue, enqueued } = recordingQueue();
    const db = createFakeSupabase({ from: () => ({ data: { id: GARAGE_ID, slug: "hartley-road", name: "Hartley Road Motors", timezone: "Europe/London", status: "active", garage_domains: [] } }) });
    const handler = createRemindersSendHandler({ repo: () => fakeRepo([]).repo });
    const sunday = new Date("2026-10-25T10:00:00Z");
    const result = await handler({ garageId: GARAGE_ID }, jobContext({ job: jobRow("reminders.send", { garageId: GARAGE_ID }, GARAGE_ID), db: db.client, now: sunday, queue }));
    expect(result).toMatchObject({ outcome: "deferred" });
    expect(enqueued).toEqual([{
      kind: "reminders.send",
      payload: { garageId: GARAGE_ID },
      options: { garageId: GARAGE_ID, runAt: new Date("2026-10-26T09:00:00.000Z"), dedupeKey: `reminders.send:${GARAGE_ID}:window:2026-10-26T09:00:00.000Z` },
    }]);
  });
});

describe("composing and sending", () => {
  it("sends what the claim returned, with a fresh hashed link, the opt-out line and the garage's link host", async () => {
    const row = reminder();
    const { result, calls } = await run([[row]]);
    expect(calls.claims).toEqual([{ garageId: GARAGE_ID, now: TUESDAY_11.toISOString(), limit: 10 }]);
    const [outbox] = getMockOutbox();
    expect(outbox).toMatchObject({ kind: "sms", garageId: GARAGE_ID, to: "+447700900123", idempotencyKey: `reminder_send:${row.id}` });
    expect(outbox!.senderId).toBeUndefined();

    const token = /https:\/\/hartley-road\.autofix\.vitalos\.co\.uk\/r\/([A-Za-z0-9_-]{43})\n/.exec(outbox!.body)?.[1];
    expect(token).toBeTruthy();
    expect(outbox!.body).toBe(`Hi Sam, the MOT on your Ford Focus (AB12 CDE) is due on 10 November 2026. Book a time: https://hartley-road.autofix.vitalos.co.uk/r/${token}\nHartley Road Motors. Reply STOP to opt out.`);

    const [prepared] = calls.prepared;
    expect(prepared).toMatchObject({ id: row.id, to: "+447700900123", provider: "mock", body: outbox!.body });
    expect(prepared!.linkHash).toBe(createHash("sha256").update(token!).digest("hex"));
    expect(prepared!.linkExpiresAt).toEqual(new Date(TUESDAY_11.getTime() + REMINDER_LINK_TTL_MS));
    expect(calls.sent).toEqual([{ id: row.id, messageId: `message-${row.id}`, providerMessageId: outbox!.providerMessageId, status: "queued" }]);
    expect(result).toMatchObject({ outcome: "sent", counts: { claimed: 1, sent: 1, failed: 0, refused: 0 }, more: false });
  });

  it("uses a verified custom domain for the link, and a different token for every reminder", async () => {
    const { repo, calls } = fakeRepo([[reminder(), reminder()]]);
    await sendGarageReminders({ garage: { ...garage, customDomain: "book.hartleyroad.co.uk" }, repo, channelFor: (kind) => createMockChannel(kind), now: () => TUESDAY_11, deadline: Infinity, env: PROD_ENV });
    const links = getMockOutbox().map((entry) => /(https:\/\/\S+)/.exec(entry.body)?.[1]);
    expect(links.every((link) => link?.startsWith("https://book.hartleyroad.co.uk/r/"))).toBe(true);
    expect(new Set(links).size).toBe(2);
    expect(new Set(calls.prepared.map((entry) => entry.linkHash)).size).toBe(2);
  });

  it("emails get the subject and an unsubscribe link instead of Reply STOP", async () => {
    await run([[reminder({ channel: "email" })]]);
    const [email] = getMockOutbox();
    expect(email).toMatchObject({ kind: "email", to: "sam@example.com", subject: "Your MOT is due on 10 November 2026" });
    expect(email!.body).toContain("Unsubscribe: https://hartley-road.autofix.vitalos.co.uk/unsubscribe");
    expect(email!.body).not.toMatch(/reply stop/i);
  });

  it.each([
    ["a placeholder with no value (no first name)", { customer_name: null }],
    ["an unknown placeholder", { template: "Hi {frist_name}, book here: {link}" }],
  ])("refuses to send with %s", async (_label, overrides) => {
    const row = reminder(overrides as Partial<ClaimedReminder>);
    const { result, calls } = await run([[row]]);
    expect(getMockOutbox()).toEqual([]);
    expect(calls.prepared).toEqual([]);
    expect(calls.failed).toEqual([{ id: row.id, messageId: null, code: "template_placeholders" }]);
    expect(result.counts).toMatchObject({ refused: 1, sent: 0 });
  });

  it("says 'car' when the make and model are unknown", async () => {
    await run([[reminder({ make: null, model: null })]]);
    expect(getMockOutbox()[0]!.body).toContain("the MOT on your car (AB12 CDE)");
  });
});

describe("provider results", () => {
  it("records an ambiguous result as failed and never resends it (A14)", async () => {
    const row = reminder();
    const { result, calls } = await run([[row]], { channelFor: channelReturning({ ok: false, code: "provider_error", retryable: false, providerCode: "timeout", ambiguous: true }) });
    expect(calls.failed).toEqual([{ id: row.id, messageId: `message-${row.id}`, code: "ambiguous:provider_error:timeout" }]);
    expect(calls.released).toEqual([]);
    expect(result).toMatchObject({ outcome: "sent", counts: { failed: 1 } });
  });

  it("mirrors Twilio's unsubscribed-recipient error as a STOP", async () => {
    const row = reminder();
    const { calls } = await run([[row]], { channelFor: channelReturning({ ok: false, code: "opted_out", retryable: false, providerCode: 21610 }) });
    expect(calls.failed).toEqual([{ id: row.id, messageId: `message-${row.id}`, code: "opted_out:21610" }]);
    expect(calls.optOuts).toEqual(["+447700900123"]);
  });

  it("puts rows back and stops at a rate limit, and the job retries after Retry-After", async () => {
    const [first, second] = [reminder(), reminder()];
    const { result, calls } = await run([[first!, second!]], { channelFor: channelReturning({ ok: false, code: "rate_limited", retryable: true, providerCode: 20429, retryAfterSeconds: 30 }) });
    expect(calls.released).toEqual([{ ids: [first!.id], messageIds: [`message-${first!.id}`] }, { ids: [second!.id], messageIds: [] }]);
    expect(result).toMatchObject({ outcome: "stopped", stop: { reason: "retry", code: "rate_limited:20429", retryAfterSeconds: 30 } });

    const { queue, enqueued } = recordingQueue();
    const db = createFakeSupabase({ from: () => ({ data: { id: GARAGE_ID, slug: "hartley-road", name: "Hartley Road Motors", timezone: "Europe/London", status: "active", garage_domains: [] } }) });
    const job = jobRow("reminders.send", { garageId: GARAGE_ID }, GARAGE_ID);
    const handler = createRemindersSendHandler({
      repo: () => fakeRepo([[reminder()]]).repo,
      channelFor: channelReturning({ ok: false, code: "rate_limited", retryable: true, providerCode: 20429, retryAfterSeconds: 30 }),
    });
    expect(await handler({ garageId: GARAGE_ID }, jobContext({ job, db: db.client, now: TUESDAY_11, queue }))).toMatchObject({ outcome: "rate_limited" });
    expect(enqueued).toEqual([{ kind: "reminders.send", payload: { garageId: GARAGE_ID }, options: { garageId: GARAGE_ID, runAt: new Date(TUESDAY_11.getTime() + 30_000), dedupeKey: `reminders.send:${GARAGE_ID}:retry:${job.id}` } }]);
  });

  it("retries the job with backoff after a provider 5xx", async () => {
    const db = createFakeSupabase({ from: () => ({ data: { id: GARAGE_ID, slug: "hartley-road", name: "Hartley Road Motors", timezone: "Europe/London", status: "active", garage_domains: [] } }) });
    const handler = createRemindersSendHandler({
      repo: () => fakeRepo([[reminder()]]).repo,
      channelFor: channelReturning({ ok: false, code: "provider_error", retryable: true, providerCode: 503 }),
    });
    const error = await handler({ garageId: GARAGE_ID }, jobContext({ job: jobRow("reminders.send", { garageId: GARAGE_ID }, GARAGE_ID), db: db.client, now: TUESDAY_11 })).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(JobError);
    expect(error).toMatchObject({ code: "SEND_RETRY", retry: true });
  });

  it("stops without retrying when messaging is not configured, keeping the reminders for later", async () => {
    const [first, second] = [reminder(), reminder()];
    const { result, calls } = await run([[first!, second!]], { channelFor: channelReturning({ ok: false, code: "configuration_required", retryable: false }) });
    expect(calls.failed).toEqual([]);
    expect(calls.released.flatMap((entry) => entry.ids)).toEqual([first!.id, second!.id]);
    expect(result).toMatchObject({ outcome: "stopped", stop: { reason: "configuration_required" } });
  });

  it("marks other definite failures failed (bad number)", async () => {
    const row = reminder();
    const { calls } = await run([[row]], { channelFor: channelReturning({ ok: false, code: "invalid_recipient", retryable: false, providerCode: 21211 }) });
    expect(calls.failed).toEqual([{ id: row.id, messageId: `message-${row.id}`, code: "invalid_recipient:21211" }]);
  });
});

describe("batches and time", () => {
  it("claims batch after batch until one comes back short", async () => {
    const { calls, result } = await run([[reminder(), reminder()], [reminder()]], { batchSize: 2 });
    expect(calls.claims).toHaveLength(2);
    expect(result).toMatchObject({ counts: { claimed: 3, sent: 3 }, more: false });
  });

  it("stops at the deadline, puts unsent rows back and asks for a continuation", async () => {
    let now = 0;
    const channel: (kind: ChannelKind) => MessageChannel = (kind) => {
      const mock = createMockChannel(kind);
      return { ...mock, send: async (message) => {
        now += 6_000;
        return mock.send(message);
      } };
    };
    const rows = [reminder(), reminder(), reminder()];
    const { result, calls } = await run([rows], { channelFor: channel, clock: () => now, deadline: 10_000 });
    expect(calls.sent.map((entry) => entry.id)).toEqual([rows[0]!.id, rows[1]!.id]);
    expect(calls.released).toEqual([{ ids: [rows[2]!.id], messageIds: [] }]);
    expect(result.more).toBe(true);

    const { queue, enqueued } = recordingQueue();
    const db = createFakeSupabase({ from: () => ({ data: { id: GARAGE_ID, slug: "hartley-road", name: "Hartley Road Motors", timezone: "Europe/London", status: "active", garage_domains: [] } }) });
    let clock = 0;
    const handler = createRemindersSendHandler({
      repo: () => fakeRepo([[reminder(), reminder()]]).repo,
      channelFor: (kind) => {
        const mock = createMockChannel(kind);
        return { ...mock, send: async (message) => {
          clock += 6_000;
          return mock.send(message);
        } };
      },
    });
    const job = jobRow("reminders.send", { garageId: GARAGE_ID }, GARAGE_ID);
    await handler({ garageId: GARAGE_ID }, jobContext({ job, db: db.client, now: TUESDAY_11, queue, clock: () => clock, deadline: 5_000 }));
    expect(enqueued).toEqual([{ kind: "reminders.send", payload: { garageId: GARAGE_ID }, options: { garageId: GARAGE_ID, dedupeKey: `reminders.send:${GARAGE_ID}:more:${job.id}` } }]);
  });

  it("sends nothing for a suspended garage", async () => {
    const { repo, calls } = fakeRepo([[reminder()]]);
    const result = await sendGarageReminders({ garage: { ...garage, status: "suspended" }, repo, channelFor: (kind) => createMockChannel(kind), now: () => TUESDAY_11, deadline: Infinity });
    expect(result.outcome).toBe("garage_inactive");
    expect(calls.claims).toEqual([]);
  });

  it("fans out one job per active garage per 10-minute slot", async () => {
    const { queue, enqueued } = recordingQueue();
    const db = createFakeSupabase({ from: () => ({ data: [{ id: GARAGE_ID, timezone: "Europe/London", status: "active" }] }) });
    await createRemindersSendHandler()({}, jobContext({ job: jobRow("reminders.send"), db: db.client, now: new Date("2026-10-27T11:17:00Z"), queue }));
    expect(enqueued).toEqual([{ kind: "reminders.send", payload: { garageId: GARAGE_ID }, options: { garageId: GARAGE_ID, dedupeKey: `reminders.send:${GARAGE_ID}:2026-10-27T11:10Z` } }]);
  });
});
