import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { garageEmailBrand } from "@/lib/email/brand";
import { renderBusinessEnquiryNotification } from "@/lib/email/templates/enquiries";
import { checkContactForm, toEnquiryRequest, type ContactFormValues } from "@/lib/enquiries/contact-form";
import { enquiryRequestSchema } from "@/lib/enquiries/schema";
import type { Garage } from "@/lib/tenancy/garage";
import { otherTestGarage, testGarage } from "./support/garage";

// The booking site's "Contact us" form (29 Oct 2026): checked in the browser with contactFormSchema,
// posted to POST /api/enquiries, checked again with enquiryRequestSchema; the garage is the host's.

const harness = vi.hoisted(() => ({ garage: null as Garage | null, createEnquiry: vi.fn(), verifyTurnstile: vi.fn() }));
vi.mock("@/lib/tenancy/garage", () => ({ getHostGarage: vi.fn(async () => harness.garage) }));
vi.mock("@/lib/rate-limit", () => ({ consumeRateLimit: vi.fn(async () => true) }));
vi.mock("@/lib/enquiries/repository", () => ({ createEnquiry: harness.createEnquiry }));
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: harness.verifyTurnstile }));

import { POST } from "@/app/api/enquiries/route";

const valid: ContactFormValues = {
  name: "  Test Customer ",
  phone: "07700 900123",
  email: "",
  preferredContact: "phone",
  message: "Can you fit a towbar to a 2018 Focus?",
  registration: "ab12 cde",
};

describe("contact form checks", () => {
  it("accepts a filled-in form and builds a general enquiry with no garage in it", () => {
    const checked = checkContactForm(valid);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.data).toMatchObject({ name: "Test Customer", registration: "AB12CDE" });
    const body = toEnquiryRequest(checked.data, "token");
    expect(body).toEqual({
      type: "general",
      contact: { name: "Test Customer", phone: "07700 900123", preferredContact: "phone" },
      vehicle: { registration: "AB12CDE" },
      description: "Can you fit a towbar to a 2018 Focus?",
      turnstileToken: "token",
    });
    expect(JSON.stringify(body)).not.toMatch(/garage/i);
    // The API's own schema takes exactly what the form sends.
    expect(enquiryRequestSchema.safeParse(body).success).toBe(true);
  });

  it("leaves the car and the email out when they are empty", () => {
    const checked = checkContactForm({ ...valid, registration: "", email: "  " });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const body = toEnquiryRequest(checked.data);
    expect(body).not.toHaveProperty("vehicle");
    expect(body.contact).not.toHaveProperty("email");
    expect(body).not.toHaveProperty("turnstileToken");
  });

  it("names each field to fix, in plain words", () => {
    const checked = checkContactForm({ name: "A", phone: "12345", email: "not-an-email", preferredContact: "phone", message: "Help", registration: "A" });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.fieldErrors).toEqual({
      name: "Enter your name.",
      phone: "Enter a UK phone number, for example 07700 900123.",
      email: "Enter an email address like name@example.com.",
      message: "Tell the garage a little more (at least 10 characters).",
      registration: "Enter the registration, for example AB12 CDE, or leave it empty.",
    });
  });

  it("needs an email address for an email reply and a mobile for WhatsApp", () => {
    const byEmail = checkContactForm({ ...valid, preferredContact: "email" });
    expect(byEmail.ok ? null : byEmail.fieldErrors.email).toBe("Enter your email address, or choose another way to be contacted.");
    const byWhatsapp = checkContactForm({ ...valid, phone: "01302 555000", preferredContact: "whatsapp" });
    expect(byWhatsapp.ok ? null : byWhatsapp.fieldErrors.phone).toBe("WhatsApp needs a mobile number. Enter a mobile, or choose a phone call.");
    // A landline is fine for a phone call.
    expect(checkContactForm({ ...valid, phone: "01302 555000" }).ok).toBe(true);
    expect(checkContactForm({ ...valid, preferredContact: "email", email: "me@example.com" }).ok).toBe(true);
  });
});

describe("enquiryRequestSchema (POST /api/enquiries)", () => {
  const base = {
    type: "general",
    contact: { name: "Test Customer", phone: "07700900123", preferredContact: "phone" },
    description: "Can you fit a towbar to a 2018 Focus?",
  };

  it("takes the Turnstile token as optional, an empty email as none and a spaced registration", () => {
    const parsed = enquiryRequestSchema.safeParse({ ...base, contact: { ...base.contact, email: "" }, vehicle: { registration: "ab12 cde" } });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.contact.email).toBeUndefined();
    expect(parsed.data?.vehicle?.registration).toBe("AB12CDE");
    expect(parsed.data?.turnstileToken).toBeUndefined();
  });

  it("refuses an email reply without an email address, and drops anything garage-like", () => {
    expect(enquiryRequestSchema.safeParse({ ...base, contact: { ...base.contact, preferredContact: "email" } }).success).toBe(false);
    const parsed = enquiryRequestSchema.safeParse({ ...base, garageId: otherTestGarage().id, garage_id: otherTestGarage().id });
    expect(parsed.success).toBe(true);
    expect(JSON.stringify(parsed.data)).not.toContain(otherTestGarage().id);
  });
});

describe("the garage's new-enquiry email", () => {
  it("calls a contact-form enquiry a message (SOB's repair enquiries keep 'Problem')", () => {
    const input = {
      brand: garageEmailBrand(testGarage()),
      enquiryId: "9f99f1f0-2252-4b5e-9000-9bc913650f15",
      customerName: "Test Customer",
      phone: "07700 900123",
      preferredContact: "phone",
      description: "Can you fit a towbar to a 2018 Focus?",
    };
    const general = renderBusinessEnquiryNotification({ ...input, type: "general" });
    expect(general.html).toContain(">Message</p>");
    expect(general.text).toContain("Message:\nCan you fit a towbar");
    expect(general.text).not.toContain("Problem:");
    expect(renderBusinessEnquiryNotification({ ...input, type: "repair" }).text).toContain("Problem:");
  });
});

function post(body: unknown) {
  return POST(
    new NextRequest("https://hartley-road.autofix.vitalos.co.uk/api/enquiries", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.9" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/enquiries human check", () => {
  const body = toEnquiryRequest((checkContactForm(valid) as { ok: true; data: Parameters<typeof toEnquiryRequest>[0] }).data);

  beforeEach(() => {
    vi.clearAllMocks();
    harness.garage = testGarage();
    harness.createEnquiry.mockResolvedValue({ id: "9f99f1f0-2252-4b5e-9000-9bc913650f15", persisted: true, notificationStatus: "sent" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("without Turnstile configured, saves the enquiry for the host's garage", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
    const response = await post(body);
    expect(response.status).toBe(201);
    expect(harness.verifyTurnstile).not.toHaveBeenCalled();
    expect(harness.createEnquiry).toHaveBeenCalledWith(testGarage(), expect.objectContaining({ type: "general", vehicle: { registration: "AB12CDE" } }));
  });

  it("with Turnstile configured, refuses a missing or failed check and saves nothing", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret");
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "site");
    harness.verifyTurnstile.mockResolvedValue(false);
    expect((await post(body)).status).toBe(403);
    expect((await post({ ...body, turnstileToken: "bad" })).status).toBe(403);
    expect(harness.verifyTurnstile).toHaveBeenLastCalledWith("bad", "198.51.100.9");
    expect(harness.createEnquiry).not.toHaveBeenCalled();

    harness.verifyTurnstile.mockResolvedValue(true);
    expect((await post({ ...body, turnstileToken: "good" })).status).toBe(201);
    expect(harness.createEnquiry).toHaveBeenCalledTimes(1);
  });

  it("404s off a garage host", async () => {
    harness.garage = null;
    expect((await post(body)).status).toBe(404);
    expect(harness.createEnquiry).not.toHaveBeenCalled();
  });
});
