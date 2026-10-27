import { beforeEach, describe, expect, it, vi } from "vitest";
import { getResendConfig, sendTransactionalEmail } from "@/lib/email/resend";
import { createEnquiry } from "@/lib/enquiries/repository";
import { createAdminClient } from "@/lib/supabase/server";
import { createInitialEnquiryMessage, getEnquiryReplyAddress } from "@/lib/enquiries/thread-repository";
import { testGarage } from "./support/garage";

vi.mock("@/lib/email/resend", () => ({
  getResendConfig: vi.fn(),
  sendTransactionalEmail: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/enquiries/thread-repository", () => ({
  createInitialEnquiryMessage: vi.fn(),
  getEnquiryReplyAddress: vi.fn(),
}));

const garage = testGarage();

describe("enquiry persistence and notification pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists a general enquiry for the host's garage before emailing the garage and customer", async () => {
    const events: string[] = [];
    const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
    const updateFilters: Array<[string, unknown]> = [];
    const lookups: Array<[string, string, unknown]> = [];
    const adminClient = {
      from(table: string) {
        return {
          select() {
            const chain = {
              eq(field: string, value: unknown) {
                lookups.push([table, field, value]);
                return chain;
              },
              maybeSingle: async () => ({ data: null, error: null }),
            };
            return chain;
          },
          insert(payload: Record<string, unknown>) {
            events.push(`${table}:insert`);
            inserts.push({ table, payload });
            if (table === "customers") return { select: () => ({ single: async () => ({ data: { id: "customer-id" }, error: null }) }) };
            if (table === "enquiries") return { select: () => ({ single: async () => ({ data: { id: "enquiry-id" }, error: null }) }) };
            return Promise.resolve({ data: payload, error: null });
          },
          update(payload: unknown) {
            events.push(`${table}:update:${JSON.stringify(payload)}`);
            const chain = {
              eq(field: string, value: unknown) {
                updateFilters.push([field, value]);
                return chain;
              },
              then(resolve: (value: unknown) => unknown) {
                return Promise.resolve({ error: null }).then(resolve);
              },
            };
            return chain;
          },
        };
      },
    };

    vi.mocked(createAdminClient).mockReturnValue(adminClient as never);
    vi.mocked(createInitialEnquiryMessage).mockResolvedValue(undefined);
    vi.mocked(getEnquiryReplyAddress).mockResolvedValue("enquiry+9f99f1f0-2252-4b5e-9000-9bc913650f15@reply.autofix.vitalos.co.uk");
    vi.mocked(getResendConfig).mockReturnValue({
      apiKey: "test-key",
      from: "Autofix <notifications@autofix.vitalos.co.uk>",
      fromAddress: "notifications@autofix.vitalos.co.uk",
      replyTo: null,
    });
    vi.mocked(sendTransactionalEmail).mockImplementation(async () => {
      events.push("email:send");
      return { data: { id: "email-id" }, error: null } as never;
    });

    const result = await createEnquiry(garage, {
      type: "general",
      contact: { name: "Test Customer", email: "customer@example.com", phone: "07700900123", preferredContact: "email" },
      description: "The vehicle has an intermittent warning light.",
      turnstileToken: "test-token",
    });

    expect(result).toEqual({ id: "enquiry-id", persisted: true, notificationStatus: "sent" });
    expect(events.indexOf("enquiries:insert")).toBeLessThan(events.indexOf("email:send"));
    // Every service-role insert names the garage explicitly.
    for (const insert of inserts) expect(insert.payload, insert.table).toMatchObject({ garage_id: garage.id });
    expect(updateFilters).toContainEqual(["garage_id", garage.id]);
    // The customer is looked up by E.164 phone within the garage, then created.
    expect(lookups).toEqual([["customers", "garage_id", garage.id], ["customers", "phone", "+447700900123"]]);
    expect(inserts.find((insert) => insert.table === "customers")?.payload).toMatchObject({ phone: "+447700900123" });
    expect(createInitialEnquiryMessage).toHaveBeenCalledWith(garage, "enquiry-id", expect.objectContaining({ description: "The vehicle has an intermittent warning light." }));
    expect(sendTransactionalEmail).toHaveBeenNthCalledWith(1, expect.objectContaining({
      senderName: "Hartley Road Motors",
      to: "bookings@hartleyroad.example",
      replyTo: "customer@example.com",
      subject: "New general enquiry",
      html: expect.stringContaining("NEW ENQUIRY"),
      text: expect.stringContaining("NEW ENQUIRY"),
    }));
    expect(sendTransactionalEmail).toHaveBeenNthCalledWith(2, expect.objectContaining({
      senderName: "Hartley Road Motors",
      to: "customer@example.com",
      subject: "We received your Hartley Road Motors request",
      replyTo: "enquiry+9f99f1f0-2252-4b5e-9000-9bc913650f15@reply.autofix.vitalos.co.uk",
      html: expect.stringContaining("Sent by Autofix on behalf of Hartley Road Motors"),
      text: expect.stringContaining("REQUEST RECEIVED"),
    }));
    expect(events).toContain(`enquiries:update:${JSON.stringify({ notification_status: "sent" })}`);
  });

  it("skips the staff alert for a garage without an email address", async () => {
    const adminClient = {
      from: () => ({
        select: () => { const chain = { eq: () => chain, maybeSingle: async () => ({ data: null, error: null }) }; return chain; },
        insert: (payload: Record<string, unknown>) => ({ select: () => ({ single: async () => ({ data: { id: `${String(payload.type ?? "row")}-id` }, error: null }) }), then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve) }),
        update: () => { const chain = { eq: () => chain, then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve) }; return chain; },
      }),
    };
    vi.mocked(createAdminClient).mockReturnValue(adminClient as never);
    vi.mocked(getResendConfig).mockReturnValue({ apiKey: "k", from: "Autofix <n@autofix.vitalos.co.uk>", fromAddress: "n@autofix.vitalos.co.uk", replyTo: null });
    vi.mocked(getEnquiryReplyAddress).mockResolvedValue(null);
    vi.mocked(sendTransactionalEmail).mockResolvedValue({ data: { id: "email-id" }, error: null } as never);

    await createEnquiry(testGarage({ email: null }), {
      type: "general",
      contact: { name: "Test Customer", email: "customer@example.com", phone: "07700900123", preferredContact: "email" },
      description: "Brakes squeal.",
      turnstileToken: "test-token",
    });
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1);
    expect(sendTransactionalEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "customer@example.com" }));
  });

  it("reuses the garage's customer and vehicle and never deletes them when the enquiry fails", async () => {
    const events: string[] = [];
    const adminClient = {
      from(table: string) {
        return {
          select() {
            const chain = { eq: () => chain, maybeSingle: async () => ({ data: { id: `existing-${table}` }, error: null }) };
            return chain;
          },
          insert(payload: Record<string, unknown>) {
            events.push(`${table}:insert`);
            return { select: () => ({ single: async () => ({ data: { id: `${table}-id`, ...payload }, error: null }) }) };
          },
          delete() {
            events.push(`${table}:delete`);
            const chain = { eq: () => chain, then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve) };
            return chain;
          },
        };
      },
    };
    vi.mocked(createAdminClient).mockReturnValue(adminClient as never);
    vi.mocked(createInitialEnquiryMessage).mockRejectedValue(new Error("thread failed"));

    await expect(createEnquiry(garage, {
      type: "repair",
      contact: { name: "Returning Customer", email: "customer@example.com", phone: "+44 7700 900123", preferredContact: "phone" },
      vehicle: { registration: "YD19KXT" },
      description: "Grinding noise from the front brakes.",
      turnstileToken: "test-token",
    })).rejects.toThrow("Could not create the enquiry conversation");
    expect(events).toEqual(["enquiries:insert", "enquiries:delete"]);
  });
});
