import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockChannel } from "@/lib/messaging/mock";
import { clearMockOutbox, getMockOutbox, type MessageChannel } from "@/lib/messaging/channel";
import { createResendEmailChannel } from "@/lib/messaging/email";
import { platformEnquirySchema, topicLabel } from "@/lib/platform-enquiries/schema";
import { createPlatformEnquiry, notifyPlatformEnquiry, PlatformEnquiryUnavailable, platformEnquiryRecipient, type StoredPlatformEnquiry } from "@/lib/platform-enquiries/server";
import { rateLimitIdentifierHash } from "@/lib/rate-limit";

const enquiry: StoredPlatformEnquiry = {
  id: "4e000000-0000-4000-8000-000000000001",
  receivedAt: "2026-10-29T10:05:00Z",
  name: "Priya Shah",
  email: "priya@example.com",
  phone: "07700 900123",
  garageName: "Shah Motors",
  topic: "sales",
  message: "We would like a demo for our two sites.\nMondays suit us.",
};

describe("contact form schema", () => {
  it("trims, lower-cases the email and drops empty optional fields", () => {
    const parsed = platformEnquirySchema.parse({ name: "  Priya Shah ", email: " Priya@Example.COM ", phone: "  ", garageName: "", topic: "general", message: "  Hello there,\r\nhow does MOT work?  " });
    expect(parsed).toEqual({ name: "Priya Shah", email: "priya@example.com", phone: undefined, garageName: undefined, topic: "general", message: "Hello there,\nhow does MOT work?" });
  });

  it.each([
    ["+44 (0)7700 900123", true],
    ["0113 496 0000", true],
    ["+1-202-555-0143", true],
    ["12345", false],
    ["call me maybe", false],
  ])("checks the phone %s", (phone, ok) => {
    const result = platformEnquirySchema.safeParse({ name: "Priya", email: "p@example.com", phone, topic: "support", message: "Help with my booking page." });
    expect(result.success).toBe(ok);
  });

  it("refuses control characters in single-line fields and messages over 5000 characters", () => {
    const base = { name: "Priya", email: "p@example.com", topic: "support", message: "Help with my booking page." };
    expect(platformEnquirySchema.safeParse({ ...base, name: "Priya\nBcc: x@example.com" }).success).toBe(false);
    expect(platformEnquirySchema.safeParse({ ...base, message: "x".repeat(5001) }).success).toBe(false);
    expect(platformEnquirySchema.safeParse({ ...base, message: "x".repeat(5000) }).success).toBe(true);
  });

  it("labels topics", () => {
    expect(topicLabel("sales")).toBe("Sales or a demo");
    expect(topicLabel("partnership")).toBe("Partnership");
  });
});

describe("rateLimitIdentifierHash", () => {
  it("is the day-salted SHA-256 the rate limiter keys on", () => {
    const hash = rateLimitIdentifierHash("203.0.113.9", new Date("2026-10-29T23:59:00Z"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rateLimitIdentifierHash("203.0.113.9", new Date("2026-10-29T00:00:00Z"))).toBe(hash);
    expect(rateLimitIdentifierHash("203.0.113.9", new Date("2026-10-30T00:00:00Z"))).not.toBe(hash);
  });
});

describe("createPlatformEnquiry", () => {
  function fakeClient(result: { data: unknown; error: unknown }) {
    const calls: Array<{ table: string; row: Record<string, unknown> }> = [];
    const client = {
      from: (table: string) => ({
        insert: (row: Record<string, unknown>) => {
          calls.push({ table, row });
          return { select: () => ({ single: async () => result }) };
        },
      }),
    };
    return { client: client as never, calls };
  }

  it("inserts the form with the service client and returns the id", async () => {
    const { client, calls } = fakeClient({ data: { id: enquiry.id, received_at: enquiry.receivedAt }, error: null });
    const { id, receivedAt, ...input } = enquiry;
    const stored = await createPlatformEnquiry({ ...input, phone: undefined }, { client, ipHash: "b".repeat(64) });
    expect(stored).toMatchObject({ id, receivedAt, email: "priya@example.com" });
    expect(calls).toEqual([{
      table: "platform_enquiries",
      row: { name: "Priya Shah", email: "priya@example.com", phone: null, garage_name: "Shah Motors", topic: "sales", message: enquiry.message, ip_hash: "b".repeat(64) },
    }]);
  });

  it("never stores something that is not a hash as ip_hash", async () => {
    const { client, calls } = fakeClient({ data: { id: enquiry.id, received_at: enquiry.receivedAt }, error: null });
    await createPlatformEnquiry(enquiry, { client, ipHash: "203.0.113.9" });
    expect(calls[0]!.row.ip_hash).toBeNull();
  });

  it("throws when there is no database or the insert fails", async () => {
    await expect(createPlatformEnquiry(enquiry, { client: null })).rejects.toBeInstanceOf(PlatformEnquiryUnavailable);
    const { client } = fakeClient({ data: null, error: { message: "violates check constraint" } });
    await expect(createPlatformEnquiry(enquiry, { client })).rejects.toBeInstanceOf(PlatformEnquiryUnavailable);
  });
});

describe("notifyPlatformEnquiry", () => {
  beforeEach(() => clearMockOutbox());
  afterEach(() => vi.unstubAllEnvs());

  it("sends nothing while PLATFORM_ENQUIRY_EMAIL is empty or not an address", async () => {
    expect(platformEnquiryRecipient({})).toBeNull();
    expect(platformEnquiryRecipient({ PLATFORM_ENQUIRY_EMAIL: "  " })).toBeNull();
    expect(platformEnquiryRecipient({ PLATFORM_ENQUIRY_EMAIL: "not an address" })).toBeNull();
    expect(await notifyPlatformEnquiry(enquiry, { env: {}, channel: createMockChannel("email") })).toEqual({ status: "not_configured" });
    expect(getMockOutbox()).toEqual([]);
  });

  it("emails the recipient once per enquiry, with the sender as Reply-To", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://pitline.co.uk");
    const env = { PLATFORM_ENQUIRY_EMAIL: "hello@vitalos.example" };
    const channel = createMockChannel("email");
    expect(await notifyPlatformEnquiry(enquiry, { env, channel })).toEqual({ status: "sent" });
    expect(await notifyPlatformEnquiry(enquiry, { env, channel })).toEqual({ status: "sent" });
    const outbox = getMockOutbox();
    expect(outbox).toHaveLength(1);
    const [sent] = outbox;
    expect(sent).toMatchObject({
      kind: "email",
      garageId: "platform",
      to: "hello@vitalos.example",
      replyTo: "priya@example.com",
      subject: "New enquiry: Sales or a demo from Priya Shah",
      idempotencyKey: `platform_enquiry:${enquiry.id}`,
    });
    expect(sent!.body).toContain("Mondays suit us.");
    expect(sent!.body).toContain("Shah Motors");
    expect(sent!.body).toContain(`https://pitline.co.uk/superadmin/enquiries/${enquiry.id}/`);
    expect(sent!.html).toContain("We would like a demo for our two sites.<br>Mondays suit us.");
  });

  it("escapes what the sender typed in the HTML", async () => {
    const channel = createMockChannel("email");
    await notifyPlatformEnquiry({ ...enquiry, name: "<b>Priya</b>", message: "<script>alert(1)</script> hello" }, { env: { PLATFORM_ENQUIRY_EMAIL: "hello@vitalos.example" }, channel });
    const [sent] = getMockOutbox();
    expect(sent!.html).not.toContain("<script>");
    expect(sent!.html).toContain("&lt;script&gt;");
    expect(sent!.html).not.toContain("<b>Priya</b>");
  });

  it("reports a failed send without throwing", async () => {
    const failing: MessageChannel = { kind: "email", mode: "live", send: vi.fn(async () => ({ ok: false as const, code: "provider_error" as const, retryable: true })) };
    expect(await notifyPlatformEnquiry(enquiry, { env: { PLATFORM_ENQUIRY_EMAIL: "hello@vitalos.example" }, channel: failing })).toEqual({ status: "failed", code: "provider_error" });
    const throwing: MessageChannel = { kind: "email", mode: "live", send: vi.fn(async () => { throw new Error("boom"); }) };
    expect(await notifyPlatformEnquiry(enquiry, { env: { PLATFORM_ENQUIRY_EMAIL: "hello@vitalos.example" }, channel: throwing })).toEqual({ status: "failed", code: "provider_error" });
  });
});

describe("Reply-To on the email channel", () => {
  it("passes a valid Reply-To to Resend and drops an invalid one", async () => {
    const send = vi.fn(async () => ({ data: { id: "re_123" }, error: null }));
    const channel = createResendEmailChannel({ mode: "live", send: send as never });
    const message = { garageId: "platform", to: "hello@vitalos.example", subject: "New enquiry", body: "Hello", idempotencyKey: "platform_enquiry:1" };
    expect((await channel.send({ ...message, replyTo: "priya@example.com" })).ok).toBe(true);
    expect((await channel.send({ ...message, replyTo: "not an address" })).ok).toBe(true);
    const calls = send.mock.calls as unknown as Array<[Record<string, unknown>]>;
    expect(calls[0]![0].replyTo).toBe("priya@example.com");
    expect(calls[1]![0]).not.toHaveProperty("replyTo");
  });
});
