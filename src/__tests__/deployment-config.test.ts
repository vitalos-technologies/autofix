import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { requiredBookingVariables, requiredProductionVariables } from "@/lib/env";

const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as { regions?: string[]; crons?: Array<{ path: string; schedule: string }> };
const envExample = readFileSync(".env.example", "utf8");

describe("production deployment configuration", () => {
  it("runs functions in London, next to the Supabase project (eu-west-2)", () => {
    // Vercel's default, iad1 (Washington, D.C.), put every Supabase call on a transatlantic round trip
    // (about 125 ms each, measured 29 Oct 2026). Hobby allows one region.
    expect(vercel.regions).toEqual(["lhr1"]);
  });

  it("uses one daily cron on Vercel Hobby, inside the reminders send window", () => {
    // 11:00 UTC is 11:00 (GMT) or 12:00 (BST) in London: after the 10:00 reminder time, inside
    // 09:00–19:00, and Hobby's within-the-hour start still lands before 13:00.
    expect(vercel.crons).toEqual([{ path: "/api/cron/daily", schedule: "0 11 * * *" }]);
  });

  it("uses the Supabase secret-key contract without the legacy variable", () => {
    expect(envExample).toContain("SUPABASE_SECRET_KEY=");
    expect(envExample).not.toContain("SUPABASE_SERVICE_ROLE_KEY=");
    expect(requiredProductionVariables).toContain("SUPABASE_SECRET_KEY");
    expect(requiredProductionVariables).toContain("ENQUIRY_REPLY_DOMAIN");
    expect(requiredProductionVariables).toContain("RESEND_WEBHOOK_SECRET");
    expect(requiredProductionVariables).toContain("CLOUDFLARE_EMAIL_WEBHOOK_SECRET");
    expect(requiredProductionVariables).not.toContain("RESEND_INBOUND_DOMAIN");
    expect(envExample).toContain("ENQUIRY_REPLY_DOMAIN=reply.autofix.vitalos.co.uk");
    // Single-business notification addresses are gone: staff alerts go to each garage's own email.
    expect(requiredProductionVariables).not.toContain("ENQUIRY_NOTIFICATION_EMAIL");
    expect(requiredProductionVariables).not.toContain("RESEND_REPLY_TO");
  });

  it("does not make safe-fallback integrations production blockers", () => {
    expect(requiredProductionVariables).not.toContain("DVLA_API_KEY");
    expect(requiredProductionVariables).not.toContain("VEHICLE_DATA_GLOBAL_API_KEY");
    expect(requiredProductionVariables).not.toContain("NEXT_PUBLIC_GA_MEASUREMENT_ID");
    expect(requiredProductionVariables).not.toContain("SENTRY_DSN");
  });

  it("keeps booking credentials server-only and separately degradable", () => {
    expect(requiredBookingVariables).toEqual(["BOOKING_MANAGEMENT_SECRET"]);
    for (const name of requiredBookingVariables) {
      expect(envExample).toContain(`${name}=`);
      expect(name).not.toMatch(/^NEXT_PUBLIC_/);
      expect(requiredProductionVariables).not.toContain(name);
    }
  });

  it("documents the Vehicle Data Global integration without exposing a key", () => {
    expect(envExample).toContain("VEHICLE_LOOKUP_PROVIDER=vehicle-data-global");
    expect(envExample).toContain("VEHICLE_DATA_GLOBAL_API_KEY=");
    expect(envExample).toContain("VEHICLE_DATA_GLOBAL_BASE_URL=https://uk.api.vehicledataglobal.com");
    expect(envExample).toContain("VEHICLE_DATA_GLOBAL_PACKAGE=VehicleDetails");
  });
});
