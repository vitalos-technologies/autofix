import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaimedCampaignSend } from "@/lib/campaigns/compose";
import { campaignLinkPath, sendGarageCampaigns, type CampaignSendGarage, type CampaignSendRepo } from "@/lib/campaigns/send";
import { verifyUnsubscribeToken } from "@/lib/consent/unsubscribe-token";
import { createCampaignsSendHandler } from "@/lib/jobs/handlers/campaigns-send";
import { JOB_KINDS } from "@/lib/jobs/types";
import { CRON_JOBS } from "@/lib/jobs/cron";
import type { ChannelKind, MessageChannel, SendResult } from "@/lib/messaging/channel";
import { clearMockOutbox, createMockChannel, getMockOutbox } from "@/lib/messaging/mock";
import { REMINDER_LINK_TTL_MS } from "@/lib/reminders/link-token";
import { createFakeSupabase } from "./support/fake-supabase";
import { jobContext, jobRow, recordingQueue } from "./support/jobs";

// campaigns.send (P5.5): the send window in the garage's time zone (quiet hours, both clock
// changes), what goes into each message (hashed /c/ link, opt-out line, email unsubscribe link),
// what happens on each provider result, and the job's fan-out and re-queueing.

const GARAGE_ID = "a0000000-0000-4000-8000-00000000000a";
const TUESDAY_11 = new Date("2026-10-27T11:00:00Z");
const PROD_ENV = { NODE_ENV: "production", NEXT_PUBLIC_TENANT_ROOT_DOMAIN: "autofix.vitalos.co.uk" };
const garage: CampaignSendGarage = { id: GARAGE_ID, slug: "hartley-road", customDomain: null, name: "Hartley Road Motors", timezone: "Europe/London", status: "active" };

let sequence = 0;
function row(overrides: Partial<ClaimedCampaignSend> = {}): ClaimedCampaignSend {
  sequence += 1;
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    campaign_id: "00000000-0000-4000-8000-0000000000c0",
    channel: "sms",
    send_at: "2026-10-27T09:00:00Z",
    template: "{garage}: Hi {first_name}, winter check for your {vehicle} ({reg})? Book: {link}",
    email_subject: "Winter is coming, {first_name}",
    email_template: null,
    service_id: null,
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

function fakeRepo(batches: ClaimedCampaignSend[][]) {
  const calls = {
    claims: [] as Array<{ now: string; limit: number }>,
    prepared: [] as Array<{ id: string; linkHash: string; linkExpiresAt: Date; body: string; to: string; provider: string }>,
    sent: [] as string[],
    failed: [] as Array<{ id: string; code: string }>,
    released: [] as Array<{ ids: string[]; messageIds: string[] }>,
    optOuts: [] as string[],
  };
  const queue = [...batches];
  const repo: CampaignSendRepo = {
    claim: vi.fn(async (_garageId, now, limit) => {
      calls.claims.push({ now: now.toISOString(), limit });
      return queue.shift() ?? [];
    }),
    prepare: vi.fn(async (_garageId, send, prepared) => {
      calls.prepared.push({ id: send.id, ...prepared });
      return { messageId: `message-${send.id}` };
    }),
    markSent: vi.fn(async (_garageId, id) => {
      calls.sent.push(id);
    }),
    markFailed: vi.fn(async (_garageId, id, _messageId, code) => {
      calls.failed.push({ id, code });
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

async function run(batches: ClaimedCampaignSend[][], options: { now?: Date; channelFor?: (kind: ChannelKind) => MessageChannel; env?: Record<string, string | undefined> } = {}) {
  const { repo, calls } = fakeRepo(batches);
  const result = await sendGarageCampaigns({
    garage,
    repo,
    channelFor: options.channelFor ?? ((kind) => createMockChannel(kind)),
    now: () => options.now ?? TUESDAY_11,
    deadline: Number.MAX_SAFE_INTEGER,
    clock: () => 0,
    env: options.env ?? PROD_ENV,
    batchSize: 10,
  });
  return { result, calls };
}

beforeEach(() => clearMockOutbox());

describe("campaigns.send in the job registry", () => {
  it("is a job kind drained after reminders.send, with its own cron and in the daily one", () => {
    expect(JOB_KINDS.indexOf("campaigns.send")).toBe(JOB_KINDS.indexOf("reminders.send") + 1);
    expect(CRON_JOBS["campaigns.send"]).toEqual(["campaigns.send"]);
    expect(CRON_JOBS.daily).toContain("campaigns.send");
  });
});

describe("quiet hours (09:00-19:00 Mon-Sat, garage time zone)", () => {
  it.each([
    ["Sunday after BST ended", "2026-11-01T12:00:00Z", "2026-11-02T09:00:00.000Z"],
    ["Sunday 29 March 2026, the day BST starts", "2026-03-29T10:00:00Z", "2026-03-30T08:00:00.000Z"],
    ["Sunday 25 October 2026, the day BST ends", "2026-10-25T10:00:00Z", "2026-10-26T09:00:00.000Z"],
    ["a weekday evening", "2026-10-27T19:30:00Z", "2026-10-28T09:00:00.000Z"],
  ])("claims nothing on %s and says when the window opens", async (_label, at, next) => {
    const { result, calls } = await run([[row()]], { now: new Date(at) });
    expect(result).toMatchObject({ outcome: "deferred", deferUntil: new Date(next) });
    expect(calls.claims).toEqual([]);
    expect(getMockOutbox()).toEqual([]);
  });

  it("re-queues the garage's job for the next window", async () => {
    const { queue, enqueued } = recordingQueue();
    const db = createFakeSupabase({ from: () => ({ data: { id: GARAGE_ID, slug: "hartley-road", name: "Hartley Road Motors", timezone: "Europe/London", status: "active", garage_domains: [] } }) });
    const handler = createCampaignsSendHandler({ repo: () => fakeRepo([]).repo });
    const result = await handler({ garageId: GARAGE_ID }, jobContext({ job: jobRow("campaigns.send", { garageId: GARAGE_ID }, GARAGE_ID), db: db.client, now: new Date("2026-10-25T10:00:00Z"), queue }));
    expect(result).toMatchObject({ outcome: "deferred" });
    expect(enqueued).toEqual([
      {
        kind: "campaigns.send",
        payload: { garageId: GARAGE_ID },
        options: { garageId: GARAGE_ID, runAt: new Date("2026-10-26T09:00:00.000Z"), dedupeKey: `campaigns.send:${GARAGE_ID}:window:2026-10-26T09:00:00.000Z` },
      },
    ]);
  });

  it("fans out to every garage with due sends, once per 10-minute slot", async () => {
    const { queue, enqueued } = recordingQueue();
    const handler = createCampaignsSendHandler({ garagesWithDueSends: async () => [GARAGE_ID, "b0000000-0000-4000-8000-00000000000b"] });
    const result = await handler({}, jobContext({ job: jobRow("campaigns.send"), db: createFakeSupabase({}).client, now: TUESDAY_11, queue }));
    expect(result).toEqual({ outcome: "fanned_out", counts: { garages: 2 } });
    expect(enqueued.map((entry) => entry.options.dedupeKey)).toEqual([`campaigns.send:${GARAGE_ID}:2026-10-27T11:00Z`, "campaigns.send:b0000000-0000-4000-8000-00000000000b:2026-10-27T11:00Z"]);
  });
});

describe("composing and sending", () => {
  it("sends a fresh hashed /c/ link with the opt-out line, from the garage's link host", async () => {
    const send = row();
    const { result, calls } = await run([[send]]);
    const [outbox] = getMockOutbox();
    expect(outbox).toMatchObject({ kind: "sms", garageId: GARAGE_ID, to: "+447700900123", idempotencyKey: `campaign_send:${send.id}` });
    const token = /https:\/\/hartley-road\.autofix\.vitalos\.co\.uk\/c\/([A-Za-z0-9_-]{22})/.exec(outbox!.body)?.[1];
    expect(token).toBeTruthy();
    expect(outbox!.body).toBe(`Hartley Road Motors: Hi Sam, winter check for your Ford Focus (AB12 CDE)? Book: https://hartley-road.autofix.vitalos.co.uk/c/${token}\nReply STOP to opt out.`);
    expect(calls.prepared[0]!.linkHash).toBe(createHash("sha256").update(token!).digest("hex"));
    expect(calls.prepared[0]!.linkExpiresAt).toEqual(new Date(TUESDAY_11.getTime() + REMINDER_LINK_TTL_MS));
    expect(result).toMatchObject({ outcome: "sent", counts: { claimed: 1, sent: 1 } });
    expect(campaignLinkPath(token!)).toBe(`/c/${token}`);
  });

  it("WhatsApp gets the opt-out line too", async () => {
    await run([[row({ channel: "whatsapp" })]]);
    expect(getMockOutbox()[0]!.body.endsWith("Reply STOP to opt out.")).toBe(true);
  });

  it("emails use the email wording and subject, with the signed unsubscribe link and no Reply STOP", async () => {
    const send = row({ channel: "email", email_template: "Hello {first_name}, {garage} here. Winter checks this month: {link}" });
    const env = { ...PROD_ENV, BOOKING_MANAGEMENT_SECRET: "test-booking-management-secret-0123456789" };
    await run([[send]], { env });
    const [email] = getMockOutbox();
    expect(email).toMatchObject({ kind: "email", to: "sam@example.com", subject: "Winter is coming, Sam" });
    expect(email!.body.startsWith("Hello Sam, Hartley Road Motors here.")).toBe(true);
    const link = /\nStop reminders: https:\/\/hartley-road\.autofix\.vitalos\.co\.uk\/unsubscribe\/(\S+)$/.exec(email!.body);
    expect(verifyUnsubscribeToken(GARAGE_ID, link![1]!, env)).toBe(send.customer_id);
    expect(email!.body).not.toMatch(/reply stop/i);
  });

  it("refuses wording with a placeholder it cannot fill, without sending", async () => {
    const { calls, result } = await run([[row({ template: "{garage}: {due_date} {link}" })]]);
    expect(getMockOutbox()).toEqual([]);
    expect(calls.failed).toEqual([expect.objectContaining({ code: "template_placeholders" })]);
    expect(result.counts.refused).toBe(1);
  });

  it("a provider opt-out (21610) is mirrored as STOP", async () => {
    const send = row();
    const { calls } = await run([[send]], { channelFor: channelReturning({ ok: false, code: "opted_out", retryable: false, providerCode: 21610 }) });
    expect(calls.failed).toEqual([{ id: send.id, code: "opted_out:21610" }]);
    expect(calls.optOuts).toEqual(["+447700900123"]);
  });

  it("an ambiguous result is failed and never retried", async () => {
    const { calls, result } = await run([[row()]], { channelFor: channelReturning({ ok: false, code: "provider_error", retryable: true, ambiguous: true }) });
    expect(calls.failed[0]!.code).toMatch(/^ambiguous:/);
    expect(calls.released).toEqual([]);
    expect(result.outcome).toBe("sent");
  });

  it("missing configuration puts the row back and stops", async () => {
    const first = row();
    const second = row();
    const { calls, result } = await run([[first, second]], { channelFor: channelReturning({ ok: false, code: "configuration_required", retryable: false }) });
    expect(calls.released).toEqual([{ ids: [first.id], messageIds: [`message-${first.id}`] }, { ids: [second.id], messageIds: [] }]);
    expect(result).toMatchObject({ outcome: "stopped", stop: { reason: "configuration_required" } });
  });

  it("an inactive garage sends nothing", async () => {
    const { repo, calls } = fakeRepo([[row()]]);
    const result = await sendGarageCampaigns({ garage: { ...garage, status: "suspended" }, repo, channelFor: (kind) => createMockChannel(kind), now: () => TUESDAY_11, deadline: Infinity, env: PROD_ENV });
    expect(result.outcome).toBe("garage_inactive");
    expect(calls.claims).toEqual([]);
  });
});
