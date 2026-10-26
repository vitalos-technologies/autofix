import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { siteConfig } from "@/config/site";
import { contactLinks } from "@/config/site";
import { approvedInvoiceReplyTo, productionEmailSender } from "@/lib/email/identity";

describe("public contact email separation", () => {
  it("publishes the domain address while retaining protected delivery identities", () => {
    expect(siteConfig.email).toBe("info@sobautofix.com");
    expect(contactLinks.email).toBe("mailto:info@sobautofix.com");
    expect(productionEmailSender).toBe("SOB Autofix <notifications@sobautofix.com>");
    expect(approvedInvoiceReplyTo).toBe("info@sobautofix.com");
  });

  it("takes invoice issuer contact details from the garage instead of SOB defaults", () => {
    const migration = readFileSync("supabase/migrations/20261026000100_tenancy.sql", "utf8");
    expect(migration).toContain("alter column issuer_email drop default");
    expect(migration).toContain("coalesce(garage.email, '')");
    expect(migration).not.toContain("sobautofix.com");
  });

  it("keeps routing, sender and masked-reply configuration unchanged", () => {
    const env = readFileSync(".env.example", "utf8");
    expect(env).toContain("RESEND_FROM_EMAIL=SOB Autofix <notifications@sobautofix.com>");
    expect(env).toContain("RESEND_REPLY_TO=sobautofix@gmail.com");
    expect(env).toContain("ENQUIRY_NOTIFICATION_EMAIL=sobautofix@gmail.com");
    expect(env).toContain("ENQUIRY_REPLY_DOMAIN=reply.sobautofix.com");
  });
});
