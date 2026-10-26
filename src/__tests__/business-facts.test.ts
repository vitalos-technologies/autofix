import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { siteConfig } from "@/config/site";

// SOB's single-business facts stay in src/config/site.ts until P1.3 replaces
// them with a per-request GarageContext.
describe("approved business facts", () => {
  it("does not publish unconfirmed opening hours", () => {
    expect(Object.values(siteConfig.openingHours).every((hours) => hours === "")).toBe(true);
  });

  it("uses the confirmed phone number for phone and WhatsApp", () => {
    expect(siteConfig.phone).toBe("07469273483");
    expect(siteConfig.whatsapp).toBe("07469273483");
    expect(siteConfig.phone).toBe(siteConfig.whatsapp);
  });

  it("uses the public domain address without exposing the destination mailbox", () => {
    expect(siteConfig.email).toBe("info@sobautofix.com");
  });

  it("uses the approved transparent logo variants", () => {
    const logoComponent = readFileSync(join(process.cwd(), "src/components/layout/logo.tsx"), "utf8");
    const rootLayout = readFileSync(join(process.cwd(), "src/app/layout.tsx"), "utf8");
    expect(logoComponent).toContain("assets/sobautofix_logo.png");
    expect(logoComponent).toContain("assets/sobautofix_logo-white.png");
    expect(rootLayout).toContain("assets/sobautofix_siteicon.png");
  });
});
