import { describe, expect, it } from "vitest";
import { LEGACY_ROOT_DOMAIN, legacyHostDecision } from "@/lib/tenancy/legacy-hosts";
import type { HostEnvironment } from "@/lib/tenancy/hosts";

const pitline: HostEnvironment = { NEXT_PUBLIC_ADMIN_HOST: "pitline.co.uk", NEXT_PUBLIC_TENANT_ROOT_DOMAIN: "pitline.co.uk" };
const stillAutofix: HostEnvironment = { NEXT_PUBLIC_ADMIN_HOST: LEGACY_ROOT_DOMAIN, NEXT_PUBLIC_TENANT_ROOT_DOMAIN: LEGACY_ROOT_DOMAIN };

const decide = (url: string, env = pitline) => legacyHostDecision(url, new URL(url).host, env);

describe("legacyHostDecision", () => {
  it("sends the old admin host to the admin host, path and query intact", () => {
    expect(decide("https://autofix.vitalos.co.uk/")).toEqual({ kind: "redirect", location: "https://pitline.co.uk/" });
    expect(decide("https://autofix.vitalos.co.uk/app/login?returnTo=%2Fapp%2Fbookings&x=1")).toEqual({
      kind: "redirect",
      location: "https://pitline.co.uk/app/login?returnTo=%2Fapp%2Fbookings&x=1",
    });
  });

  it("sends an old free link to the same slug under the tenant root", () => {
    expect(decide("https://hartley-road.autofix.vitalos.co.uk/time?service=mot")).toEqual({
      kind: "redirect",
      location: "https://hartley-road.pitline.co.uk/time?service=mot",
    });
    expect(legacyHostDecision("https://x/", "Hartley-Road.AUTOFIX.vitalos.co.uk:443", pitline)).toEqual({
      kind: "redirect",
      location: "https://hartley-road.pitline.co.uk/",
    });
  });

  it("follows the configured hosts, not fixed ones", () => {
    const env = { NEXT_PUBLIC_ADMIN_HOST: "app.pitline.co.uk", NEXT_PUBLIC_TENANT_ROOT_DOMAIN: "book.pitline.co.uk" };
    expect(decide("https://autofix.vitalos.co.uk/a", env)).toEqual({ kind: "redirect", location: "https://app.pitline.co.uk/a" });
    expect(decide("https://demo-b.autofix.vitalos.co.uk/a", env)).toEqual({ kind: "redirect", location: "https://demo-b.book.pitline.co.uk/a" });
  });

  it("keeps webhook and cron paths on the old host", () => {
    for (const path of ["/api/webhooks", "/api/webhooks/twilio/voice?step=relay", "/api/cron", "/api/cron/daily"]) {
      expect(decide(`https://autofix.vitalos.co.uk${path}`)).toEqual({ kind: "serve" });
      expect(decide(`https://hartley-road.autofix.vitalos.co.uk${path}`)).toEqual({ kind: "serve" });
    }
    expect(decide("https://autofix.vitalos.co.uk/api/webhooksx")).toMatchObject({ kind: "redirect" });
    expect(decide("https://autofix.vitalos.co.uk/api/slots")).toMatchObject({ kind: "redirect" });
  });

  it("does nothing while the old root is still the configured one", () => {
    expect(decide("https://autofix.vitalos.co.uk/app", stillAutofix)).toBeNull();
    expect(decide("https://hartley-road.autofix.vitalos.co.uk/", stillAutofix)).toBeNull();
    expect(decide("https://autofix.vitalos.co.uk/app", { NEXT_PUBLIC_ADMIN_HOST: LEGACY_ROOT_DOMAIN, NEXT_PUBLIC_TENANT_ROOT_DOMAIN: "pitline.co.uk" })).toBeNull();
  });

  it("ignores every other host, lookalikes and labels that cannot be a garage", () => {
    for (const url of [
      "https://pitline.co.uk/",
      "https://hartley-road.pitline.co.uk/",
      "https://book.hartleyroad.co.uk/",
      "https://vitalos.co.uk/",
      "https://autofix.vitalos.co.uk.evil.example/",
      "https://evilautofix.vitalos.co.uk/",
      "https://a.b.autofix.vitalos.co.uk/",
      "https://www.autofix.vitalos.co.uk/",
      "https://ab.autofix.vitalos.co.uk/",
    ]) {
      expect(decide(url)).toBeNull();
    }
    expect(legacyHostDecision("https://pitline.co.uk/", null, pitline)).toBeNull();
  });
});
