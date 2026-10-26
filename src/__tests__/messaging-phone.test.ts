import { describe, expect, it } from "vitest";
import { isE164, isUkMobileE164, maskPhone, toE164UK } from "@/lib/messaging/phone";

// Ofcom drama range: 07700 900000 to 900999 is never allocated.
describe("toE164UK", () => {
  it.each([
    ["07700 900123", "+447700900123"],
    ["07700900123", "+447700900123"],
    ["(07700) 900-123", "+447700900123"],
    ["+44 7700 900123", "+447700900123"],
    ["+447700900123", "+447700900123"],
    ["+44 (0)7700 900123", "+447700900123"],
    ["+44 07700 900123", "+447700900123"],
    ["0044 7700 900123", "+447700900123"],
    ["447700900123", "+447700900123"],
    ["7700900123", "+447700900123"],
    ["whatsapp:+447700900123", "+447700900123"],
    [" 07700.900.123 ", "+447700900123"],
    ["07624 123456", "+447624123456"],
  ])("%j -> %s", (input, expected) => {
    expect(toE164UK(input)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "0770090012", // too short
    "077009001234", // too long
    "07000 123456", // 070 personal number, not a mobile
    "07600 123456", // 076 pager
    "06700 900123",
    "+33 6 12 34 56 78", // France
    "+1 415 555 0100",
    "07700 9OO123", // letters
    "07700+900123",
    "call me on 07700 900123",
    "0113 496 0000", // landline, mobiles only by default
    null,
    undefined,
  ])("rejects %j", (input) => {
    expect(toE164UK(input)).toBeNull();
  });

  it("accepts landlines only when asked", () => {
    expect(toE164UK("0113 496 0000", { allowLandline: true })).toBe("+441134960000");
    expect(toE164UK("020 7946 0000", { allowLandline: true })).toBe("+442079460000");
    expect(toE164UK("0303 123 4567", { allowLandline: true })).toBe("+443031234567");
    expect(toE164UK("0800 123 4567", { allowLandline: true })).toBeNull();
    expect(toE164UK("07700 900123", { allowLandline: true })).toBe("+447700900123");
  });
});

describe("isE164 and isUkMobileE164", () => {
  it("checks E.164 shape", () => {
    expect(isE164("+447700900123")).toBe(true);
    expect(isE164("+15005550006")).toBe(true);
    expect(isE164("447700900123")).toBe(false);
    expect(isE164("+0447700900123")).toBe(false);
    expect(isE164("whatsapp:+447700900123")).toBe(false);
    expect(isE164(undefined)).toBe(false);
  });

  it("checks UK mobiles", () => {
    expect(isUkMobileE164("+447700900123")).toBe(true);
    expect(isUkMobileE164("+441134960000")).toBe(false);
    expect(isUkMobileE164("+15005550006")).toBe(false);
  });
});

describe("maskPhone", () => {
  it.each([
    ["+447700900123", "+44 7*** ***123"],
    ["07700 900123", "+44 7*** ***123"],
    ["whatsapp:+447700900123", "+44 7*** ***123"],
    ["+441134960000", "+44 1*** ***000"],
    ["+15005550006", "+15*** ***006"],
    ["12345", "***"],
    ["", ""],
    [null, ""],
  ])("%j -> %j", (input, expected) => {
    expect(maskPhone(input)).toBe(expected);
  });

  it("never reveals the middle digits", () => {
    const masked = maskPhone("+447700900123");
    expect(masked).not.toContain("7700");
    expect(masked).not.toContain("900");
  });
});
