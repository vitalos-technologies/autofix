import { describe, expect, it } from "vitest";
import {
  formatMailbox,
  isValidEmailAddress,
  mailboxAddress,
  resolveReplyTo,
  senderDisplayName,
} from "@/lib/email/identity";

describe("transactional email identity", () => {
  it("reads the platform sender address from RESEND_FROM_EMAIL", () => {
    expect(mailboxAddress("Autofix <notifications@autofix.vitalos.co.uk>")).toBe("notifications@autofix.vitalos.co.uk");
    expect(mailboxAddress("notifications@autofix.vitalos.co.uk")).toBe("notifications@autofix.vitalos.co.uk");
    expect(mailboxAddress("Autofix <not-an-address>")).toBeNull();
    expect(mailboxAddress(undefined)).toBeNull();
  });

  it("puts the garage's name on the platform address", () => {
    expect(formatMailbox("Hartley Road Motors", "notifications@autofix.vitalos.co.uk")).toBe('"Hartley Road Motors" <notifications@autofix.vitalos.co.uk>');
  });

  it("cannot be used to inject another address or header through the display name", () => {
    expect(senderDisplayName('Evil" <boss@example.com>\r\nBcc: x@example.com')).toBe("Evil boss example.com Bcc: x example.com");
    expect(formatMailbox("<attacker@example.com>", "notifications@autofix.vitalos.co.uk")).toBe('"attacker example.com" <notifications@autofix.vitalos.co.uk>');
    expect(senderDisplayName("   ")).toBe("Autofix");
  });

  it("defaults replies to the given address and accepts a validated override", () => {
    expect(resolveReplyTo("bookings@hartleyroad.example")).toBe("bookings@hartleyroad.example");
    expect(resolveReplyTo("bookings@hartleyroad.example", "customer@example.com")).toBe("customer@example.com");
  });

  it("rejects malformed reply-to values", () => {
    expect(isValidEmailAddress("not-an-email")).toBe(false);
    expect(() => resolveReplyTo("bookings@hartleyroad.example", "not-an-email")).toThrow();
  });
});
