import "server-only";

import { accentForWhiteText, DEFAULT_ACCENT } from "@/lib/branding/accent";
import type { Garage } from "@/lib/tenancy/garage";
import { addressLine, formatPhoneForDisplay, telHref } from "@/lib/tenancy/contact";
import { adminBaseUrl, garageBaseUrl } from "@/lib/tenancy/urls";

/** The platform's own name. The admin, staff and account emails are Autofix-branded. */
export const PLATFORM_NAME = "Autofix";

/** Who an email speaks for: a garage (customer and staff mail) or the platform (account mail). */
export type EmailBrand = {
  kind: "garage" | "platform";
  /** Trading name shown in headings and the From display name. */
  name: string;
  /** Legal name for the footer. */
  legalName: string;
  tagline: string | null;
  /** Button colour; always passes 4.5:1 with white text. */
  accent: string;
  phone: string | null;
  phoneHref: string | null;
  email: string | null;
  address: string;
  /** Host shown in the footer, e.g. `hartley-road.autofix.vitalos.co.uk`. */
  website: string;
  /** Origin that relative links resolve against (the garage's booking host or the admin host). */
  baseUrl: string;
  /** Absolute https logo, or null for the text wordmark. */
  logoUrl: string | null;
  companyNumber: string | null;
};

export type EmailGarage = Pick<Garage, "name" | "legalName" | "tagline" | "accent" | "phone" | "email" | "address" | "slug" | "customDomain" | "logoUrl" | "companyNumber">;

function absoluteLogo(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function hostOf(origin: string) {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** Branding for mail sent on behalf of a garage: its name, colour, contact details and booking host. */
export function garageEmailBrand(garage: EmailGarage): EmailBrand {
  const baseUrl = garageBaseUrl(garage);
  return {
    kind: "garage",
    name: garage.name,
    legalName: garage.legalName?.trim() || garage.name,
    tagline: garage.tagline,
    accent: accentForWhiteText(garage.accent || DEFAULT_ACCENT),
    phone: garage.phone ? formatPhoneForDisplay(garage.phone) : null,
    phoneHref: telHref(garage.phone),
    email: garage.email,
    address: addressLine(garage.address),
    website: hostOf(baseUrl),
    baseUrl,
    logoUrl: absoluteLogo(garage.logoUrl),
    companyNumber: garage.companyNumber,
  };
}

/** Branding for platform mail (account security). */
export function platformEmailBrand(): EmailBrand {
  const baseUrl = adminBaseUrl();
  return {
    kind: "platform",
    name: PLATFORM_NAME,
    legalName: `${PLATFORM_NAME} by Vitalos`,
    tagline: "Online booking and garage management",
    accent: DEFAULT_ACCENT,
    phone: null,
    phoneHref: null,
    email: null,
    address: "",
    website: hostOf(baseUrl),
    baseUrl,
    logoUrl: null,
    companyNumber: null,
  };
}

/** An absolute link against the brand's host. */
export function brandUrl(brand: Pick<EmailBrand, "baseUrl">, path: string) {
  return new URL(path, `${brand.baseUrl}/`).toString();
}
