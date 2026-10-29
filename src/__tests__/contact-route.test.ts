import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/contact: rate limits, zod, Turnstile, then the insert (service key) and the email.

const harness = vi.hoisted(() => ({
  rateLimit: vi.fn<(identifier: string, scope: string, limit?: number, window?: number) => Promise<boolean>>(async () => true),
  turnstile: vi.fn<(token?: string, ip?: string) => Promise<boolean>>(async () => true),
  create: vi.fn(),
  notify: vi.fn(async () => ({ status: "sent" })),
}));

vi.mock("@/lib/rate-limit", () => ({
  consumeRateLimit: harness.rateLimit,
  rateLimitIdentifierHash: () => "a".repeat(64),
}));
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: harness.turnstile }));
vi.mock("@/lib/platform-enquiries/server", () => ({
  createPlatformEnquiry: harness.create,
  notifyPlatformEnquiry: harness.notify,
}));

import { POST } from "@/app/api/contact/route";

const valid = {
  name: "Priya Shah",
  email: "Priya@Example.com",
  phone: "07700 900123",
  garageName: "Shah Motors",
  topic: "sales",
  message: "We would like a demo for our two sites.",
  turnstileToken: "token-123",
};

function post(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("https://autofix.vitalos.co.uk/api/contact", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9, 10.0.0.1", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/contact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.rateLimit.mockResolvedValue(true);
    harness.turnstile.mockResolvedValue(true);
    harness.create.mockImplementation(async (input: Record<string, unknown>) => ({ ...input, id: "4e000000-0000-4000-8000-000000000001", receivedAt: "2026-10-29T10:00:00Z" }));
    harness.notify.mockResolvedValue({ status: "sent" });
  });

  it("stores a valid enquiry, emails Vitalos and answers 201", async () => {
    const response = await POST(post({ ...valid, garageId: "someone-else", status: "closed" }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ success: true, id: "4e000000-0000-4000-8000-000000000001" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(harness.create).toHaveBeenCalledTimes(1);
    const [input, options] = harness.create.mock.calls[0] as [Record<string, unknown>, { ipHash: string }];
    // Only the form's fields are stored: no status, garage or token from the body.
    expect(input).toEqual({ name: "Priya Shah", email: "priya@example.com", phone: "07700 900123", garageName: "Shah Motors", topic: "sales", message: "We would like a demo for our two sites." });
    expect(options.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(harness.turnstile).toHaveBeenCalledWith("token-123", "203.0.113.9");
    expect(harness.notify).toHaveBeenCalledTimes(1);
  });

  it("rate limits per source, overall and per email address", async () => {
    await POST(post(valid));
    const scopes = harness.rateLimit.mock.calls.map(([identifier, scope, limit, window]) => [identifier, scope, limit, window]);
    expect(scopes).toEqual([
      ["203.0.113.9", "platform_enquiry_ip", 5, 3600],
      ["all", "platform_enquiry_all", 200, 3600],
      ["priya@example.com", "platform_enquiry_email", 3, 3600],
    ]);

    harness.rateLimit.mockResolvedValueOnce(false);
    const limited = await POST(post(valid));
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.message).toMatch(/Too many messages/);
  });

  it("answers 400 with a message per field and stores nothing", async () => {
    const response = await POST(post({ name: "P", email: "nope", topic: "billing", message: "short", turnstileToken: "" }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.fields).toMatchObject({
      name: "Enter your name.",
      email: "Enter a valid email address.",
      topic: "Choose what your message is about.",
      message: "Write at least 10 characters.",
      turnstileToken: "Complete the security check.",
    });
    expect(harness.create).not.toHaveBeenCalled();
  });

  it.each(["not json", "null", "[]"])("answers 400 for a body that is not a form (%s)", async (raw) => {
    expect((await POST(post(raw))).status).toBe(400);
    expect(harness.create).not.toHaveBeenCalled();
  });

  it("refuses a body that is too large before reading it", async () => {
    const response = await POST(post(valid, { "content-length": "50000" }));
    expect(response.status).toBe(413);
    expect(harness.rateLimit).not.toHaveBeenCalled();
  });

  it("answers 403 when the human check fails", async () => {
    harness.turnstile.mockResolvedValue(false);
    const response = await POST(post(valid));
    expect(response.status).toBe(403);
    expect(harness.create).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it("answers 503 when the enquiry cannot be stored, and sends no email", async () => {
    harness.create.mockRejectedValue(new Error("down"));
    const response = await POST(post(valid));
    expect(response.status).toBe(503);
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it("still answers 201 when the email is not configured", async () => {
    harness.notify.mockResolvedValue({ status: "not_configured" });
    expect((await POST(post(valid))).status).toBe(201);
  });
});
