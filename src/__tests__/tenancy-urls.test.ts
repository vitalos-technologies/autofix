import { describe, expect, it } from "vitest";
import { addressLine, addressLines, formatPhoneForDisplay, telHref, whatsappHref } from "@/lib/tenancy/contact";
import { adminBaseUrl, adminUrl, garageBaseUrl, garageUrl } from "@/lib/tenancy/urls";

const production = { NODE_ENV: "production", NEXT_PUBLIC_TENANT_ROOT_DOMAIN: "autofix.vitalos.co.uk", NEXT_PUBLIC_ADMIN_HOST: "autofix.vitalos.co.uk" };
const development = { NODE_ENV: "development", DEV_TENANT_ROOT_DOMAIN: "localhost:3000" };

describe("garageBaseUrl", () => {
  it("uses the free link on the tenant root in production", () => {
    expect(garageBaseUrl({ slug: "hartley-road" }, production)).toBe("https://hartley-road.autofix.vitalos.co.uk");
    expect(garageBaseUrl({ slug: "hartley-road", customDomain: null }, production)).toBe("https://hartley-road.autofix.vitalos.co.uk");
  });

  it("prefers the garage's verified custom domain", () => {
    expect(garageBaseUrl({ slug: "hartley-road", customDomain: "book.hartleyroad.co.uk" }, production)).toBe("https://book.hartleyroad.co.uk");
    expect(garageBaseUrl({ slug: "hartley-road", customDomain: "Book.HartleyRoad.co.uk." }, production)).toBe("https://book.hartleyroad.co.uk");
  });

  it("ignores a custom domain value that carries a port", () => {
    expect(garageBaseUrl({ slug: "hartley-road", customDomain: "book.hartleyroad.co.uk:8443" }, production)).toBe("https://hartley-road.autofix.vitalos.co.uk");
  });

  it("follows NEXT_PUBLIC_TENANT_ROOT_DOMAIN and defaults to autofix.vitalos.co.uk", () => {
    expect(garageBaseUrl({ slug: "demo-b" }, { NODE_ENV: "production", NEXT_PUBLIC_TENANT_ROOT_DOMAIN: "garages.example.test" })).toBe("https://demo-b.garages.example.test");
    expect(garageBaseUrl({ slug: "demo-b" }, { NODE_ENV: "production" })).toBe("https://demo-b.autofix.vitalos.co.uk");
  });

  it("uses <slug>.localhost:3000 over http in development, even with a custom domain", () => {
    expect(garageBaseUrl({ slug: "hartley-road", customDomain: "book.hartleyroad.co.uk" }, development)).toBe("http://hartley-road.localhost:3000");
    expect(garageBaseUrl({ slug: "hartley-road" }, { NODE_ENV: "test" })).toBe("http://hartley-road.localhost:3000");
  });

  it("builds absolute links on the garage host", () => {
    expect(garageUrl({ slug: "hartley-road" }, "/manage-booking", production)).toBe("https://hartley-road.autofix.vitalos.co.uk/manage-booking");
    expect(garageUrl({ slug: "hartley-road", customDomain: "book.hartleyroad.co.uk" }, "/api/bookings/calendar/HRM-4821?signature=a%2Bb", production))
      .toBe("https://book.hartleyroad.co.uk/api/bookings/calendar/HRM-4821?signature=a%2Bb");
  });
});

describe("adminBaseUrl", () => {
  it("uses NEXT_PUBLIC_SITE_URL's origin when set", () => {
    expect(adminBaseUrl({ ...production, NEXT_PUBLIC_SITE_URL: "https://autofix.vitalos.co.uk/some/path" })).toBe("https://autofix.vitalos.co.uk");
    expect(adminUrl("/app/bookings", { NEXT_PUBLIC_SITE_URL: "http://localhost:3000" })).toBe("http://localhost:3000/app/bookings");
  });

  it("falls back to the admin host in production and localhost in development", () => {
    expect(adminBaseUrl(production)).toBe("https://autofix.vitalos.co.uk");
    expect(adminBaseUrl({ NODE_ENV: "production" })).toBe("https://autofix.vitalos.co.uk");
    expect(adminBaseUrl({ NODE_ENV: "development" })).toBe("http://localhost:3000");
    expect(adminBaseUrl({ NODE_ENV: "production", NEXT_PUBLIC_SITE_URL: "not a url" })).toBe("https://autofix.vitalos.co.uk");
  });
});

describe("garage contact formatting", () => {
  it("formats E.164 UK numbers for display", () => {
    expect(formatPhoneForDisplay("+441302000101")).toBe("01302 000101");
    expect(formatPhoneForDisplay("+447700900123")).toBe("07700 900123");
    expect(formatPhoneForDisplay("+442071234567")).toBe("020 7123 4567");
    expect(formatPhoneForDisplay(null)).toBe("");
  });

  it("builds call and WhatsApp links, or none", () => {
    expect(telHref("+441302000101")).toBe("tel:+441302000101");
    expect(telHref("01302 000101")).toBe("tel:+441302000101");
    expect(telHref(null)).toBeNull();
    expect(whatsappHref("+447700900101")).toBe("https://wa.me/447700900101");
    expect(whatsappHref("")).toBeNull();
  });

  it("joins the address lines that are present", () => {
    const address = { line1: "4 Hartley Road", line2: " ", town: "Doncaster", postcode: "DN1 2AB" };
    expect(addressLines(address)).toEqual(["4 Hartley Road", "Doncaster", "DN1 2AB"]);
    expect(addressLine(address)).toBe("4 Hartley Road, Doncaster, DN1 2AB");
    expect(addressLine({})).toBe("");
    expect(addressLine(null)).toBe("");
  });
});
