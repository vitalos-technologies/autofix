import { beforeEach, describe, expect, it, vi } from "vitest";
import { testGarage } from "./support/garage";

// The thread repository runs with the service role (shared by webhooks and the
// admin), so every statement must name the garage. This harness records every
// query and lets each test assert the garage filters.

type Call = { table: string; operation: string; payload?: unknown; filters: Array<[string, string, unknown]> };

const harness = vi.hoisted(() => ({
  calls: [] as Call[],
  rpcCalls: [] as Array<[string, Record<string, unknown>]>,
  responses: new Map<string, unknown>(),
  sends: [] as Array<Record<string, unknown>>,
  audits: [] as Array<[string, Record<string, unknown>]>,
}));

function queryBuilder(table: string) {
  const call: Call = { table, operation: "select", filters: [] };
  harness.calls.push(call);
  const result = () => ({ data: harness.responses.get(`${table}:${call.operation}`) ?? null, error: null });
  const builder: Record<string, unknown> = {};
  const chain = (name: string, value?: unknown) => {
    void name;
    void value;
    return builder;
  };
  Object.assign(builder, {
    select: () => builder,
    insert: (payload: unknown) => { call.operation = "insert"; call.payload = payload; return builder; },
    update: (payload: unknown) => { call.operation = "update"; call.payload = payload; return builder; },
    upsert: (payload: unknown) => { call.operation = "upsert"; call.payload = payload; return builder; },
    delete: () => { call.operation = "delete"; return builder; },
    eq: (field: string, value: unknown) => { call.filters.push(["eq", field, value]); return builder; },
    in: (field: string, value: unknown) => { call.filters.push(["in", field, value]); return builder; },
    is: (field: string, value: unknown) => { call.filters.push(["is", field, value]); return builder; },
    not: (field: string, op: string, value: unknown) => { call.filters.push(["not", field, `${op}:${String(value)}`]); return builder; },
    order: () => builder,
    limit: (value: number) => chain("limit", value),
    single: async () => result(),
    maybeSingle: async () => result(),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
  });
  return builder;
}

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => queryBuilder(table),
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      harness.rpcCalls.push([name, args]);
      return { data: [{ stored_message_id: "message-id", was_inserted: true }], error: null };
    }),
  }),
}));
vi.mock("@/lib/admin/audit", () => ({
  recordAdminAudit: vi.fn(async (garageId: string, entry: Record<string, unknown>) => {
    harness.audits.push([garageId, entry]);
    return true;
  }),
}));
vi.mock("@/lib/email/resend", () => ({
  getResendConfig: () => ({ apiKey: "k", from: "Autofix <notifications@autofix.vitalos.co.uk>", fromAddress: "notifications@autofix.vitalos.co.uk", replyTo: null }),
  getResendReplyConfig: () => ({ inboundDomain: "reply.autofix.vitalos.co.uk" }),
  sendTransactionalEmail: vi.fn(async (message: Record<string, unknown>) => {
    harness.sends.push(message);
    return { data: { id: "provider-email-id" }, error: null };
  }),
  retrieveSentEmail: vi.fn(async () => ({ message_id: "<sent@autofix>" })),
  retrieveReceivedEmail: vi.fn(),
}));
vi.mock("@/lib/enquiries/inbound-config", () => ({ getEnquiryReplyDomain: () => "reply.autofix.vitalos.co.uk" }));

import { addInternalNote, markEnquiryThreadRead, processNormalizedInboundEmail, sendEnquiryReply } from "@/lib/enquiries/thread-repository";

const garage = testGarage();
const enquiryId = "6f1c2a8e-91f4-4d3b-8a3e-1b2c3d4e5f60";
const actorId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const replyToken = "9f99f1f0-2252-4b5e-9000-9bc913650f15";

function garageScoped(call: Call) {
  if (call.operation === "insert" || call.operation === "upsert") {
    const rows = Array.isArray(call.payload) ? call.payload : [call.payload];
    return rows.every((row) => (row as Record<string, unknown>).garage_id === garage.id);
  }
  return call.filters.some(([kind, field, value]) => kind === "eq" && field === "garage_id" && value === garage.id);
}

describe("enquiry threads are scoped to one garage", () => {
  beforeEach(() => {
    harness.calls = [];
    harness.rpcCalls = [];
    harness.sends = [];
    harness.audits = [];
    harness.responses = new Map<string, unknown>([
      ["enquiries:select", { id: enquiryId, type: "general", status: "new", customers: { name: "Test Customer", email: "customer@example.com" } }],
      ["enquiry_conversations:upsert", { reply_token: replyToken, subject: "Re: Your Hartley Road Motors general enquiry" }],
      ["enquiry_messages:insert", { id: "message-id", provider_email_id: null, delivery_status: "sending" }],
    ]);
  });

  it("sends a reply as the garage and filters every statement by the admin's garage", async () => {
    await sendEnquiryReply(garage, { enquiryId, body: "We can see it on Thursday.", clientRequestId: "5f04ae56-b240-45f0-b984-0d4e1156218f", actorId, actorName: "Sam Owner" });
    const tenantCalls = harness.calls.filter((call) => ["enquiries", "enquiry_messages", "enquiry_conversations"].includes(call.table));
    expect(tenantCalls.length).toBeGreaterThan(4);
    for (const call of tenantCalls) expect(garageScoped(call), `${call.table} ${call.operation}`).toBe(true);
    expect(harness.sends[0]).toMatchObject({
      senderName: "Hartley Road Motors",
      to: "customer@example.com",
      replyTo: `enquiry+${replyToken}@reply.autofix.vitalos.co.uk`,
    });
    expect(String(harness.sends[0]?.html)).toContain("Sent by Autofix on behalf of Hartley Road Motors");
    expect(harness.audits).toEqual([[garage.id, expect.objectContaining({ action: "enquiry.reply_sent", actorId })]]);
  });

  it("adds internal notes and marks threads read only within the garage", async () => {
    harness.responses.set("enquiry_messages:insert", { id: "note-id" });
    await addInternalNote(garage, { enquiryId, body: "Customer prefers mornings", actorId, actorName: "Sam Owner" });
    await markEnquiryThreadRead(garage.id, enquiryId);
    const tenantCalls = harness.calls.filter((call) => ["enquiries", "enquiry_messages", "enquiry_conversations"].includes(call.table));
    for (const call of tenantCalls) expect(garageScoped(call), `${call.table} ${call.operation}`).toBe(true);
    expect(harness.sends).toHaveLength(0);
  });

  it("files an inbound reply under the garage that owns the reply token", async () => {
    harness.responses.set("enquiry_conversations:select", { enquiry_id: enquiryId, garage_id: garage.id, subject: "Re: Your Hartley Road Motors general enquiry" });
    const result = await processNormalizedInboundEmail({
      transport: "cloudflare",
      transportEventId: "event-1",
      envelopeFrom: "customer@example.com",
      envelopeRecipients: [`enquiry+${replyToken}@reply.autofix.vitalos.co.uk`],
      from: "Test Customer <customer@example.com>",
      recipients: [],
      messageId: "<reply@example.com>",
      inReplyTo: null,
      references: [],
      subject: "Re: Your Hartley Road Motors general enquiry",
      text: "Thursday works.",
      html: null,
      headers: {},
      createdAt: "2026-10-26T10:00:00.000Z",
      attachmentCount: 0,
    });
    expect(result).toEqual({ matched: true, enquiryId });
    expect(harness.rpcCalls).toEqual([["store_inbound_email_message", expect.objectContaining({ p_garage_id: garage.id, target_enquiry_id: enquiryId })]]);
  });

  it("keeps unmatched inbound mail in the platform queue with no garage", async () => {
    const result = await processNormalizedInboundEmail({
      transport: "cloudflare",
      transportEventId: "event-2",
      envelopeFrom: "someone@example.com",
      envelopeRecipients: ["enquiry+00000000-0000-4000-8000-000000000000@reply.autofix.vitalos.co.uk"],
      from: "someone@example.com",
      recipients: [],
      messageId: null,
      inReplyTo: null,
      references: [],
      subject: "Hello",
      text: "Who is this?",
      html: null,
      headers: {},
      createdAt: "2026-10-26T10:00:00.000Z",
      attachmentCount: 0,
    });
    expect(result).toMatchObject({ matched: false });
    expect(harness.rpcCalls).toHaveLength(0);
    const unmatched = harness.calls.find((call) => call.table === "unmatched_inbound_emails");
    expect(unmatched?.operation).toBe("upsert");
    expect(unmatched?.payload).not.toHaveProperty("garage_id");
  });
});
