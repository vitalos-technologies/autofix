import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeBookingNotifications } from "@/lib/bookings/notifications";
import { UNSUBSCRIBE_COPY } from "@/lib/consent/copy";
import { optOutByPhone, optOutWithToken, resumeWithToken, UNSUBSCRIBE_FORM_LIMITS } from "@/lib/consent/unsubscribe";
import { createUnsubscribeToken, unsubscribeUrl, verifyUnsubscribeToken } from "@/lib/consent/unsubscribe-token";
import { previewBookingContext } from "@/lib/email/preview-fixtures";
import { renderTemplate, withOptOutLink } from "@/lib/messaging/templates";
import { createFakeSupabase, type FakeRpc } from "./support/fake-supabase";
import { otherTestGarage, testGarage } from "./support/garage";

const garage = testGarage();
const other = otherTestGarage();
const CUSTOMER = "0f2b9c64-8e51-4a3d-b1f7-5d6e7a8b9c01";
const ENV = { BOOKING_MANAGEMENT_SECRET: "unit-test-secret-unit-test-secret-1234", NODE_ENV: "test" };

afterEach(() => vi.unstubAllEnvs());

function fakeClient(result: Record<string, unknown> | null = { matched: true, changed: true }, error: { message: string } | null = null) {
  const fake = createFakeSupabase({ rpc: () => ({ data: result, error }) });
  return { client: fake.client as unknown as SupabaseClient, rpcs: fake.rpcs as FakeRpc[] };
}

describe("unsubscribe tokens", () => {
  it("round-trips a customer id for the garage it was issued for", () => {
    const token = createUnsubscribeToken(garage.id, CUSTOMER, ENV)!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
    expect(verifyUnsubscribeToken(garage.id, token, ENV)).toBe(CUSTOMER);
  });

  it("is refused on another garage's host, when tampered with, or with another secret", () => {
    const token = createUnsubscribeToken(garage.id, CUSTOMER, ENV)!;
    expect(verifyUnsubscribeToken(other.id, token, ENV)).toBeNull();
    const [id, tag] = token.split(".");
    const flipped = `${id}.${tag!.slice(0, -1)}${tag!.endsWith("A") ? "B" : "A"}`;
    expect(verifyUnsubscribeToken(garage.id, flipped, ENV)).toBeNull();
    const otherCustomer = createUnsubscribeToken(garage.id, "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", ENV)!;
    expect(verifyUnsubscribeToken(garage.id, `${otherCustomer.split(".")[0]}.${tag}`, ENV)).toBeNull();
    expect(verifyUnsubscribeToken(garage.id, token, { ...ENV, BOOKING_MANAGEMENT_SECRET: "a-different-secret-a-different-secret" })).toBeNull();
    for (const bad of ["", "nope", `${token}x`, "../../etc"]) expect(verifyUnsubscribeToken(garage.id, bad, ENV)).toBeNull();
  });

  it("refuses every other spelling of the same bytes in the last character of either part", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    // Many customers, so some tokens end in a character whose unused low bits a decoder ignores.
    for (let index = 0; index < 64; index += 1) {
      const customer = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
      const token = createUnsubscribeToken(garage.id, customer, ENV)!;
      const [id, tag] = token.split(".") as [string, string];
      for (const other of alphabet) {
        if (other !== tag.at(-1)) expect(verifyUnsubscribeToken(garage.id, `${id}.${tag.slice(0, -1)}${other}`, ENV)).toBeNull();
        if (other !== id.at(-1)) expect(verifyUnsubscribeToken(garage.id, `${id.slice(0, -1)}${other}.${tag}`, ENV)).toBeNull();
      }
      expect(verifyUnsubscribeToken(garage.id, token, ENV)).toBe(customer);
    }
  });

  it("is not issued in production without the signing secret", () => {
    expect(createUnsubscribeToken(garage.id, CUSTOMER, { NODE_ENV: "production" })).toBeNull();
    expect(verifyUnsubscribeToken(garage.id, createUnsubscribeToken(garage.id, CUSTOMER, ENV), { NODE_ENV: "production" })).toBeNull();
  });

  it("builds a link on the garage's own host with nothing personal in it", () => {
    const url = unsubscribeUrl(garage, CUSTOMER, ENV)!;
    expect(url).toMatch(/^http:\/\/hartley-road\.localhost:3000\/unsubscribe\/[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
    expect(url).not.toContain(CUSTOMER);
    expect(url).not.toMatch(/447700|07700|AB12/);
    const production = unsubscribeUrl({ ...garage, customDomain: "book.hartleyroad.example" }, CUSTOMER, { ...ENV, NODE_ENV: "production" });
    expect(production).toMatch(/^https:\/\/book\.hartleyroad\.example\/unsubscribe\//);
  });
});

describe("opting out from a signed link", () => {
  it("opts out the token's customer in the host garage only", async () => {
    vi.stubEnv("BOOKING_MANAGEMENT_SECRET", ENV.BOOKING_MANAGEMENT_SECRET);
    const token = createUnsubscribeToken(garage.id, CUSTOMER)!;
    const { client, rpcs } = fakeClient();
    await expect(optOutWithToken(garage, token, { client })).resolves.toEqual({ status: "done", changed: true });
    expect(rpcs).toEqual([{ fn: "opt_out_customer", args: { p_garage_id: garage.id, p_customer_id: CUSTOMER, p_phone: null, p_source: "unsubscribe_link" } }]);

    const elsewhere = fakeClient();
    await expect(optOutWithToken(other, token, { client: elsewhere.client })).resolves.toEqual({ status: "invalid_link" });
    expect(elsewhere.rpcs).toEqual([]);
  });

  it("is idempotent: opening the link again still shows the confirmation", async () => {
    const token = createUnsubscribeToken(garage.id, CUSTOMER)!;
    const { client } = fakeClient({ matched: true, changed: false });
    await expect(optOutWithToken(garage, token, { client })).resolves.toEqual({ status: "done", changed: false });
  });

  it("reports a database failure instead of claiming success", async () => {
    const token = createUnsubscribeToken(garage.id, CUSTOMER)!;
    const { client } = fakeClient(null, { message: "boom" });
    await expect(optOutWithToken(garage, token, { client })).resolves.toEqual({ status: "unavailable" });
  });

  it("turning reminders back on stores the shown wording as consent", async () => {
    const token = createUnsubscribeToken(garage.id, CUSTOMER)!;
    const { client, rpcs } = fakeClient({ changed: true });
    await expect(resumeWithToken(garage, token, { client })).resolves.toEqual({ status: "resumed", changed: true });
    expect(rpcs[0]).toEqual({
      fn: "resume_customer_reminders",
      args: {
        p_garage_id: garage.id,
        p_customer_id: CUSTOMER,
        p_consent_text: "Reminders are back on. Hartley Road Motors will send you reminders again. You can stop them any time.",
      },
    });
    expect(UNSUBSCRIBE_COPY.resumed).toContain("[Garage name]");
    await expect(resumeWithToken(other, token, { client })).resolves.toEqual({ status: "invalid_link" });
  });
});

describe("opting out with the form", () => {
  const allow = async () => true;

  it("gives the same answer whether or not the number is on file", async () => {
    const known = fakeClient({ matched: true, changed: true });
    const unknown = fakeClient({ matched: false, changed: false });
    const first = await optOutByPhone(garage, "07700 900123", "203.0.113.9", { client: known.client, rateLimit: allow });
    const second = await optOutByPhone(garage, "07700 900999", "203.0.113.9", { client: unknown.client, rateLimit: allow });
    expect(first).toEqual({ status: "done" });
    expect(second).toEqual(first);
    expect(known.rpcs[0]).toEqual({ fn: "opt_out_customer", args: { p_garage_id: garage.id, p_customer_id: null, p_phone: "+447700900123", p_source: "unsubscribe_form" } });
  });

  it("rejects a number that is not a UK mobile without touching the database", async () => {
    const { client, rpcs } = fakeClient();
    await expect(optOutByPhone(garage, "not a number", "203.0.113.9", { client, rateLimit: allow })).resolves.toEqual({ status: "invalid_phone" });
    expect(rpcs).toEqual([]);
  });

  it("is rate limited per IP and per garage", async () => {
    const calls: Array<[string, string, number, number]> = [];
    const limiter = async (identifier: string, scope: string, limit = 0, window = 0) => {
      calls.push([identifier, scope, limit, window]);
      return scope !== "unsubscribe_garage";
    };
    const { client, rpcs } = fakeClient();
    await expect(optOutByPhone(garage, "07700 900123", "203.0.113.9", { client, rateLimit: limiter })).resolves.toEqual({ status: "rate_limited" });
    expect(calls).toEqual([
      ["203.0.113.9", "unsubscribe_ip", UNSUBSCRIBE_FORM_LIMITS.perIp.limit, UNSUBSCRIBE_FORM_LIMITS.perIp.windowSeconds],
      [garage.id, "unsubscribe_garage", UNSUBSCRIBE_FORM_LIMITS.perGarage.limit, UNSUBSCRIBE_FORM_LIMITS.perGarage.windowSeconds],
    ]);
    expect(rpcs).toEqual([]);
  });
});

describe("unsubscribe link in messages", () => {
  const link = "https://book.hartleyroad.example/unsubscribe/abc.def";

  it("replaces Reply STOP with the link for alphanumeric SMS", () => {
    expect(withOptOutLink("Hartley Road Motors: you're booked in. Reply STOP to opt out.", link)).toBe(`Hartley Road Motors: you're booked in.\nStop reminders: ${link}`);
    expect(renderTemplate("{garage}: booked.", { garage: "Hartley Road Motors" }, { channel: "sms", optOutLink: link }).text).toBe(`Hartley Road Motors: booked.\nStop reminders: ${link}`);
    // WhatsApp and the two-way number keep Reply STOP.
    expect(renderTemplate("{garage}: booked.", { garage: "Hartley Road Motors" }, { channel: "whatsapp", optOutLink: link }).text).toBe("Hartley Road Motors: booked. Reply STOP to opt out.");
  });

  it("booking texts from an alphanumeric sender carry the link and the sender; otherwise Reply STOP", () => {
    const context = previewBookingContext(garage);
    const twoWay = composeBookingNotifications(context, "created");
    expect(twoWay.textMessage?.body).toMatch(/Reply STOP to opt out\.$/);
    expect(twoWay.textMessage?.senderId).toBeUndefined();

    const alpha = composeBookingNotifications(context, "created", { smsSenderId: "HartleyRd" });
    expect(alpha.textMessage?.senderId).toBe("HartleyRd");
    expect(alpha.textMessage?.body).toMatch(/\nStop reminders: http:\/\/hartley-road\.localhost:3000\/unsubscribe\/[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
    expect(alpha.textMessage?.body).not.toContain("Reply STOP");

    const invalid = composeBookingNotifications(context, "created", { smsSenderId: "not a valid sender" });
    expect(invalid.textMessage?.senderId).toBeUndefined();
  });

  it("customer emails link the privacy notice and the customer's own stop link", () => {
    const composed = composeBookingNotifications(previewBookingContext(garage), "created");
    const token = createUnsubscribeToken(garage.id, CUSTOMER)!;
    expect(composed.customerEmail?.html).toContain('href="http://hartley-road.localhost:3000/privacy"');
    expect(composed.customerEmail?.html).toContain(`href="http://hartley-road.localhost:3000/unsubscribe/${token}"`);
    expect(composed.customerEmail?.text).toContain(`Stop reminders: http://hartley-road.localhost:3000/unsubscribe/${token}`);
    expect(composed.staffEmail?.html).not.toContain("/unsubscribe/");
  });
});
