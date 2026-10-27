import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, filterValue, hasFilter, type FakeQuery, type FakeResult } from "./support/fake-supabase";
import { testGarage } from "./support/garage";

// Messages & calls (/app/messages): conversations and threads through the member's RLS client,
// unread via messages.read_at, staff replies claimed by claim_staff_reply() before the send (A14),
// opt-outs always win, and the Calls tab from `calls`.

const harness = vi.hoisted(() => ({
  context: null as null | Record<string, unknown>,
  loose: null as null | Record<string, unknown>,
  revalidated: [] as string[],
  audits: [] as Array<Record<string, unknown>>,
  service: null as null | { client: unknown },
  handled: [] as unknown[],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => harness.revalidated.push(path) }));
vi.mock("@/lib/tenancy/admin", () => ({
  getAdminContext: vi.fn(async (options?: { requireMfa?: boolean }) => (options?.requireMfa === false ? harness.loose ?? harness.context : harness.context)),
}));
vi.mock("@/lib/admin/audit", () => ({
  recordAdminAudit: vi.fn(async (garageId: string, entry: Record<string, unknown>) => {
    harness.audits.push({ garageId, ...entry });
    return true;
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => harness.service?.client ?? null }));
vi.mock("@/lib/calls/actions", () => ({
  markMissedCallHandled: vi.fn(async (id: unknown) => {
    harness.handled.push(id);
    return { ok: true, changed: true };
  }),
}));

const view = await import("@/lib/messages/view");
const { countUnreadMessages, hasMessagingNumber, loadInbox, loadThread, markThreadRead } = await import("@/lib/messages/inbox");
const { canReply, sendStaffReply } = await import("@/lib/messages/reply");
const { listRecentCalls } = await import("@/lib/calls/recent-calls");
const { markCallHandledAction, markThreadReadAction, replyAction } = await import("@/app/app/(protected)/messages/actions");
const { clearMockOutbox, createMockChannel, getMockOutbox } = await import("@/lib/messaging");

const garage = testGarage();
const USER = "0f8fad5b-d9cb-469f-a165-70867728950e";
const CUSTOMER = "6f1c2b9e-1d3a-4c5b-8e7f-90a1b2c3d4e5";
const OTHER = "3b2f8c1e-0a4d-4e6f-9b7a-1c2d3e4f5a6b";

const message = (overrides: Partial<import("@/lib/messages/view").MessageRow>): import("@/lib/messages/view").MessageRow => ({
  id: "m1",
  customer_id: CUSTOMER,
  channel: "sms",
  direction: "inbound",
  body: "Hello",
  status: "received",
  created_at: "2026-10-27T09:00:00Z",
  read_at: null,
  ...overrides,
});

const customer = { id: CUSTOMER, name: "Sam Driver", phone: "+447700900123", email: null, channel: "sms", opted_out_at: null, anonymised_at: null };

function signIn(role: string, handler: (query: FakeQuery) => FakeResult | undefined = () => undefined) {
  const fake = createFakeSupabase({ from: (query) => handler(query) ?? {} });
  harness.context = { user: { id: USER }, garage, role, client: fake.client, mfaState: "verified", mfaRequired: true, mfaVerified: true };
  harness.loose = harness.context;
  return fake;
}

beforeEach(() => {
  harness.context = null;
  harness.loose = null;
  harness.revalidated = [];
  harness.audits = [];
  harness.service = null;
  harness.handled = [];
  clearMockOutbox();
});

describe("conversations and threads in words", () => {
  it("makes one conversation per customer, newest first, with the unread count and a preview", () => {
    const rows = [
      message({ id: "a", created_at: "2026-10-27T10:00:00Z", direction: "outbound", status: "delivered", body: "See you Thursday at 9." }),
      message({ id: "b", created_at: "2026-10-27T09:00:00Z", body: "Can I come Thursday?" }),
      message({ id: "c", customer_id: OTHER, created_at: "2026-10-27T11:00:00Z", body: `${"Long ".repeat(30)}text`, channel: "whatsapp" }),
      message({ id: "d", customer_id: null, created_at: "2026-10-27T12:00:00Z", body: "Who is this?" }),
    ];
    const conversations = view.shapeConversations(rows, [customer, { ...customer, id: OTHER, name: "Priya Shah", opted_out_at: "2026-10-01T00:00:00Z" }], view.countUnread([{ customer_id: CUSTOMER }, { customer_id: OTHER }, { customer_id: OTHER }, { customer_id: null }]));
    expect(conversations.map((item) => [item.name, item.channel, item.unread, item.optedOut])).toEqual([
      ["Priya Shah", "whatsapp", 2, true],
      ["Sam Driver", "sms", 1, false],
    ]);
    expect(conversations[1]!.preview).toBe("You: See you Thursday at 9.");
    expect(conversations[0]!.preview.length).toBeLessThanOrEqual(view.PREVIEW_LENGTH);
    expect(conversations[0]!.preview.endsWith("…")).toBe(true);
  });

  it("labels reminder, booking and text-back messages, shows delivery and puts STOP/START in as system lines", () => {
    const items = view.threadItems(
      [
        message({ id: "r", direction: "outbound", status: "delivered", reminder_send_id: "s1", reminder_sends: { kind: "mot" }, created_at: "2026-10-26T09:00:00Z", body: "Your MOT is due" }),
        message({ id: "b", direction: "outbound", status: "failed", booking_id: "b1", bookings: [{ reference: "HRM-1042" }], created_at: "2026-10-26T10:00:00Z" }),
        message({ id: "t", direction: "outbound", status: "sending", call_id: "c1", created_at: "2026-10-27T08:00:00Z" }),
        message({ id: "s", body: "STOP", created_at: "2026-10-27T08:30:00Z", read_at: "2026-10-27T08:31:00Z" }),
        message({ id: "g", body: "Start", created_at: "2026-10-27T08:40:00Z" }),
        message({ id: "x", body: null, redacted_at: "2027-10-27T00:00:00Z", created_at: "2026-10-27T08:50:00Z" }),
      ],
      { timeZone: "Europe/London", today: "2026-10-27" },
    );
    expect(items.map((item) => (item.type === "message" ? `${item.label ?? "-"}|${item.status?.label ?? "-"}|${item.unread}` : `${item.type}:${item.type === "day" ? item.label : item.text.split(".")[0]}`))).toEqual([
      "day:Mon 26 Oct",
      "MOT reminder|Delivered|false",
      "Booking update HRM-1042|Not delivered|false",
      "day:Today",
      "Missed-call text-back|Sending|false",
      "-|-|false",
      "system:Opted out by replying STOP",
      "-|-|true",
      "system:Opted back in by replying START",
      "-|-|true",
    ]);
    const removed = items.at(-1);
    expect(removed?.type === "message" && removed.text).toBe("Message removed after 12 months.");
  });

  it("says plainly why the reply box is off", () => {
    const base = { canReply: true, hasMessagingNumber: true };
    expect(view.replyBlock({ ...base, customer })).toBeNull();
    expect(view.replyBlock({ ...base, canReply: false, customer })).toBe("You can read messages. Owners, managers and front desk can reply.");
    expect(view.replyBlock({ ...base, customer: { ...customer, opted_out_at: "2026-11-03T10:00:00Z" } })).toBe("Sam opted out on 3 Nov, so you can't text them. They can text START to opt back in.");
    expect(view.replyBlock({ ...base, customer: { ...customer, phone: null } })).toMatch(/^There's no mobile number for Sam/);
    expect(view.replyBlock({ ...base, hasMessagingNumber: false, customer })).toMatch(/doesn't have a texting number yet/);
    expect(view.replyBlock({ ...base, hasMessagingNumber: false, customer: { ...customer, channel: "email", email: "sam@example.com" } })).toBeNull();
    expect(view.replyBlock({ ...base, customer: { ...customer, channel: "email" } })).toMatch(/no email address/);
    expect(view.replyBlock({ ...base, customer: { ...customer, anonymised_at: "2026-10-01T00:00:00Z" } })).toMatch(/removed/);
    expect(view.maskedAddress(customer)).toBe("07••• •••123");
    expect(view.shortWhen("2026-10-27T09:05:00Z", { timeZone: "Europe/London", today: "2026-10-27" })).toBe("09:05");
    expect(view.shortWhen("2026-10-24T09:05:00Z", { timeZone: "Europe/London", today: "2026-10-27" })).toBe("Sat 24 Oct");
  });
});

describe("reads through the RLS client", () => {
  it("loads the inbox for the session's garage, with unread counts from read_at and unknown numbers masked", async () => {
    const fake = createFakeSupabase({
      from: (query) => {
        if (query.table === "messages" && hasFilter(query, "is", "read_at")) return { data: [{ customer_id: CUSTOMER }] };
        if (query.table === "messages") return { data: [message({}), message({ id: "u", customer_id: null, from_address: "+447700900456", body: "Hi?" })] };
        if (query.table === "customers") return { data: [customer] };
        return {};
      },
    });
    const inbox = await loadInbox(fake.client, garage.id);
    expect(inbox?.conversations).toEqual([expect.objectContaining({ customerId: CUSTOMER, unread: 1, preview: "Hello" })]);
    expect(inbox?.unknown).toEqual([expect.objectContaining({ maskedNumber: "07••• •••456", preview: "Hi?" })]);
    expect(inbox?.unreadTotal).toBe(1);
    for (const query of fake.queries) expect(filterValue(query, "eq", "garage_id")).toBe(garage.id);
    expect(fake.rpcs).toEqual([]);
  });

  it("loads a thread oldest first, and marks only inbound unread rows read, as the member", async () => {
    const fake = createFakeSupabase({
      from: (query) => {
        if (query.table === "customers") return { data: customer };
        if (query.operation === "update") return { data: [{ id: "m1" }, { id: "m2" }] };
        return { data: [message({ id: "new", created_at: "2026-10-27T10:00:00Z" }), message({ id: "old", created_at: "2026-10-27T09:00:00Z" })] };
      },
    });
    const thread = await loadThread(fake.client, garage.id, CUSTOMER);
    expect(thread?.rows.map((row) => row.id)).toEqual(["old", "new"]);
    expect(fake.queries[1]!.columns).toContain("reminder_sends(kind)");
    expect(await markThreadRead(fake.client, garage.id, CUSTOMER, USER, new Date("2026-10-27T11:00:00Z"))).toBe(2);
    const update = fake.queries.find((query) => query.operation === "update")!;
    expect(update.values).toEqual({ read_at: "2026-10-27T11:00:00.000Z", read_by: USER });
    expect(filterValue(update, "eq", "direction")).toBe("inbound");
    expect(hasFilter(update, "is", "read_at", null)).toBe(true);
    expect(filterValue(update, "eq", "garage_id")).toBe(garage.id);
  });

  it("knows whether the garage has a provisioned messaging number and counts unread", async () => {
    const fake = createFakeSupabase({ from: (query) => ({ count: query.table === "garage_phone_numbers" ? 1 : 4 }) });
    await expect(hasMessagingNumber(fake.client, garage.id)).resolves.toBe(true);
    expect(filterValue(fake.queries[0]!, "eq", "purpose")).toBe("messaging");
    expect(hasFilter(fake.queries[0]!, "not", "provider_sid")).toBe(true);
    await expect(countUnreadMessages(fake.client, garage.id)).resolves.toBe(4);
  });

  it("lists recent calls, answered and missed, with names for known numbers", async () => {
    const fake = createFakeSupabase({
      from: (query) =>
        query.table === "calls"
          ? {
              data: [
                { id: "c1", from_number: "+447700900123", created_at: "2026-10-27T09:00:00Z", missed: true, status: "no-answer", duration_s: 0, voicemail_url: "https://api.twilio.com/x", voicemail_duration_s: 12, text_back_message_id: "m", handled_at: null },
                { id: "c2", from_number: null, created_at: "2026-10-27T08:00:00Z", missed: false, status: "completed", duration_s: 125, voicemail_url: null, voicemail_duration_s: null, text_back_message_id: null, handled_at: null },
              ],
            }
          : { data: [{ name: "Sam Driver", phone: "+447700900123" }] },
    });
    const calls = await listRecentCalls(fake.client, garage.id);
    expect(calls?.map((call) => [call.callerName, call.maskedNumber, call.missed, call.handled, call.voicemailHref, call.textedBack, call.durationSeconds])).toEqual([
      ["Sam Driver", "07••• •••123", true, false, "/api/admin/calls/c1/voicemail", true, null],
      [null, null, false, false, null, false, 125],
    ]);
    expect(filterValue(fake.queries[0]!, "eq", "garage_id")).toBe(garage.id);
  });
});

describe("staff replies", () => {
  function serviceDb(claim: Record<string, unknown>, customerChannel = "sms") {
    const fake = createFakeSupabase({
      from: (query) => (query.table === "customers" ? { data: { channel: customerChannel } } : { data: [] }),
      rpc: () => ({ data: claim }),
    });
    return fake;
  }

  it("claims the row first, sends on the customer's channel, then records the result", async () => {
    const db = serviceDb({ status: "claimed", message_id: "msg-1", channel: "sms", to: "+447700900123" });
    const audit = vi.fn(async () => true);
    const result = await sendStaffReply({ garage: { id: garage.id, name: garage.name }, member: { id: USER }, customerId: CUSTOMER, body: "  Thursday at 9 works.\r\n", db: db.client, rateLimit: async () => true, channelFor: (kind) => createMockChannel(kind), audit });
    expect(result).toEqual({ ok: true, messageId: "msg-1", channel: "sms", status: expect.any(String), mode: "mock" });
    expect(db.rpcs).toEqual([{ fn: "claim_staff_reply", args: { p_garage_id: garage.id, p_customer_id: CUSTOMER, p_member_id: USER, p_body: "Thursday at 9 works.", p_provider: "mock" } }]);
    expect(getMockOutbox()).toEqual([expect.objectContaining({ kind: "sms", to: "+447700900123", body: "Thursday at 9 works.", idempotencyKey: "staff_reply:msg-1" })]);
    // No "Reply STOP" line on a conversational reply (A198).
    expect(getMockOutbox()[0]!.body).not.toMatch(/STOP/);
    const update = db.queries.find((query) => query.operation === "update")!;
    expect(update.values).toMatchObject({ status: expect.stringMatching(/sent|delivered|queued/), provider_msg_id: expect.any(String) });
    expect(filterValue(update, "eq", "id")).toBe("msg-1");
    expect(audit).toHaveBeenCalledWith(garage.id, expect.objectContaining({ action: "message.replied", detail: { outcome: "sent", channel: "sms" } }));
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/Thursday|7700900123/);
  });

  it("sends nothing when the claim says no (opt-outs always win)", async () => {
    for (const reason of ["opted_out", "not_allowed", "no_address", "no_messaging_number", "anonymised", "not_found"]) {
      clearMockOutbox();
      const db = serviceDb({ status: "skipped", reason });
      const result = await sendStaffReply({ garage: { id: garage.id, name: garage.name }, member: { id: USER }, customerId: CUSTOMER, body: "Hi", db: db.client, rateLimit: async () => true, channelFor: (kind) => createMockChannel(kind), audit: async () => true });
      expect(result).toEqual({ ok: false, code: reason });
      expect(getMockOutbox()).toEqual([]);
      expect(db.queries.filter((query) => query.operation !== "select")).toEqual([]);
    }
  });

  it("records a refused send as failed, and an email reply gets a subject", async () => {
    const db = serviceDb({ status: "claimed", message_id: "msg-2", channel: "sms", to: "+15005550001" });
    const result = await sendStaffReply({ garage: { id: garage.id, name: garage.name }, member: { id: USER }, customerId: CUSTOMER, body: "Hi", db: db.client, rateLimit: async () => true, channelFor: (kind) => createMockChannel(kind), audit: async () => true });
    expect(result).toEqual({ ok: false, code: "failed", messageId: "msg-2" });
    expect(db.queries.find((query) => query.operation === "update")!.values).toMatchObject({ status: "failed", error_code: expect.stringMatching(/^invalid_recipient/) });

    clearMockOutbox();
    const email = serviceDb({ status: "claimed", message_id: "msg-3", channel: "email", to: "sam@example.com" }, "email");
    await sendStaffReply({ garage: { id: garage.id, name: garage.name }, member: { id: USER }, customerId: CUSTOMER, body: "Hi Sam", db: email.client, rateLimit: async () => true, channelFor: (kind) => createMockChannel(kind), audit: async () => true });
    expect(getMockOutbox()[0]).toMatchObject({ kind: "email", to: "sam@example.com", subject: `Message from ${garage.name}` });
  });

  it("checks the text and the rate limit before claiming anything", async () => {
    const db = serviceDb({ status: "claimed", message_id: "x", channel: "sms", to: "+447700900123" });
    const base = { garage: { id: garage.id, name: garage.name }, member: { id: USER }, customerId: CUSTOMER, db: db.client, channelFor: (kind: "sms" | "whatsapp" | "email") => createMockChannel(kind), audit: async () => true };
    await expect(sendStaffReply({ ...base, body: "   ", rateLimit: async () => true })).resolves.toEqual({ ok: false, code: "empty" });
    await expect(sendStaffReply({ ...base, body: "x".repeat(1001), rateLimit: async () => true })).resolves.toEqual({ ok: false, code: "too_long" });
    const limiter = vi.fn(async () => false);
    await expect(sendStaffReply({ ...base, body: "Hi", rateLimit: limiter })).resolves.toEqual({ ok: false, code: "rate_limited" });
    expect(limiter).toHaveBeenCalledWith(USER, "staff_reply", 20, 600);
    expect(db.rpcs).toEqual([]);
  });

  it("lets owners, managers and front desk reply; technicians read only", async () => {
    expect(["owner", "manager", "front_desk", "technician"].map(canReply)).toEqual([true, true, true, false]);
    signIn("technician");
    const state = await replyAction({ seq: 0, status: "idle" }, (() => { const data = new FormData(); data.set("customerId", CUSTOMER); data.set("body", "Hi"); return data; })());
    expect(state).toMatchObject({ seq: 1, status: "error", message: "Only owners, managers and front desk can reply." });
    expect(getMockOutbox()).toEqual([]);
  });

  it("asks for MFA before a reply", async () => {
    harness.context = null;
    harness.loose = { user: { id: USER }, garage, role: "owner", mfaState: "challenge_required", mfaRequired: true, mfaVerified: false };
    const data = new FormData();
    data.set("customerId", CUSTOMER);
    data.set("body", "Hi");
    await expect(replyAction({ seq: 0, status: "idle" }, data)).rejects.toThrow(`REDIRECT:/app/mfa?returnTo=${encodeURIComponent(`/app/messages/${CUSTOMER}`)}&stepUp=1`);
  });

  it("replies through the service-role claim for the session's garage and marks the thread read", async () => {
    const fake = signIn("front_desk", (query) => (query.operation === "update" ? { data: [{ id: "m1" }] } : undefined));
    const db = serviceDb({ status: "claimed", message_id: "msg-9", channel: "sms", to: "+447700900123" });
    harness.service = { client: db.client };
    const data = new FormData();
    data.set("customerId", CUSTOMER);
    data.set("body", "On our way.");
    data.set("garageId", "99999999-9999-4999-8999-999999999999");
    const state = await replyAction({ seq: 3, status: "idle" }, data);
    expect(state).toMatchObject({ seq: 4, status: "sent" });
    expect(db.rpcs.find((call) => call.fn === "claim_staff_reply")!.args).toMatchObject({ p_garage_id: garage.id, p_member_id: USER, p_customer_id: CUSTOMER });
    expect(fake.queries.find((query) => query.operation === "update")).toMatchObject({ table: "messages", values: { read_by: USER } });
    expect(harness.revalidated).toEqual([`/app/messages/${CUSTOMER}`, "/app/messages"]);
  });

  it("marks a thread read for any member, and Mark handled on the Calls tab refreshes that page", async () => {
    const fake = signIn("technician", () => ({ data: [{ id: "m1" }] }));
    await expect(markThreadReadAction(CUSTOMER)).resolves.toEqual({ ok: true, marked: 1 });
    expect(fake.queries[0]).toMatchObject({ table: "messages", operation: "update" });
    await expect(markThreadReadAction("not-a-uuid")).resolves.toEqual({ ok: false, marked: 0 });
    const data = new FormData();
    data.set("callId", "c1");
    await markCallHandledAction(data);
    expect(harness.handled).toEqual(["c1"]);
    expect(harness.revalidated).toContain("/app/messages/calls");
  });
});

describe("page wiring", () => {
  it("uses no service role in the pages, never puts a number or registration in a link, and reads the garage from the session", () => {
    const files = [
      "src/app/app/(protected)/messages/page.tsx",
      "src/app/app/(protected)/messages/calls/page.tsx",
      "src/app/app/(protected)/messages/[customerId]/page.tsx",
      "src/app/app/(protected)/messages/actions.ts",
    ].map((path) => readFileSync(path, "utf8"));
    for (const source of files) {
      expect(source).not.toContain("createAdminClient(");
      expect(source).not.toMatch(/formData\.get\(["']garage/);
      expect(source).not.toMatch(/href=\{`[^`]*(phone|registration|from_number)/);
    }
    expect(files[0]).toContain("`/app/messages/${conversation.customerId}`");
  });
});
