/**
 * Garage custom-domain hostname validation (P1.8).
 *
 * Pure and dependency-free so both the server (domains client, domains.check job) and the
 * Booking page settings form (P4.3) can use it. It does not import "server-only".
 *
 * A garage connects a subdomain of a domain it owns, e.g. `book.theirgarage.co.uk`. Apex domains
 * (`theirgarage.co.uk`) are rejected because they cannot hold a CNAME record. Registrable domains
 * are worked out from a small built-in list of multi-label public suffixes (UK first) rather than
 * the full Public Suffix List, so the result is a friendly pre-check; Vercel stays the authority.
 */

export const DEFAULT_PLATFORM_DOMAINS = ["vitalos.co.uk", "pitline.co.uk"] as const;

/** Shared hosting suffixes whose subdomains belong to the host, not to the garage. */
const HOSTED_SUFFIXES = [
  "vercel.app",
  "vercel.com",
  "vercel.sh",
  "vercel-dns.com",
  "now.sh",
  "github.io",
  "netlify.app",
  "pages.dev",
  "web.app",
  "firebaseapp.com",
  "herokuapp.com",
  "azurewebsites.net",
  "wixsite.com",
  "squarespace.com",
  "blogspot.com",
  "wordpress.com",
  "webflow.io",
  "myshopify.com",
] as const;

/** Second-level public suffixes: a registrable domain under these has three labels. */
const MULTI_LABEL_SUFFIXES = new Set([
  // United Kingdom
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk", "ac.uk", "gov.uk", "nhs.uk", "police.uk", "mod.uk",
  // CentralNic UK-style suffixes
  "uk.com", "uk.net", "gb.com", "gb.net", "eu.com",
  // Crown dependencies
  "co.im", "org.im", "co.je", "org.je", "net.je", "co.gg", "org.gg", "net.gg",
  // Common elsewhere
  "com.au", "net.au", "org.au", "co.nz", "net.nz", "org.nz", "co.za", "org.za", "com.br", "co.in", "co.jp", "com.cn",
  "com.sg", "com.hk", "com.my", "co.il", "com.mx", "com.tr", "co.kr", "com.ar",
]);

const RESERVED_TLDS = new Set(["local", "test", "example", "invalid", "internal", "onion", "lan", "home", "corp", "arpa", "localdomain"]);

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

export type HostnameRejection =
  | "empty"
  | "has_scheme"
  | "has_path"
  | "has_port"
  | "wildcard"
  | "invalid_characters"
  | "too_long"
  | "ip_address"
  | "localhost"
  | "reserved_tld"
  | "platform_domain"
  | "not_owned"
  | "not_subdomain";

export type HostnameValidation =
  | {
      ok: true;
      /** Normalised hostname: lower case, punycode, no trailing dot. */
      hostname: string;
      /** Registrable domain, e.g. `theirgarage.co.uk`. */
      apexName: string;
      /** The part before the apex, e.g. `book` (the CNAME record name). */
      subdomain: string;
    }
  | { ok: false; reason: HostnameRejection; message: string };

export type HostnameValidationOptions = {
  /** Our own domains; the hostname may not equal or sit under any of them. */
  platformDomains?: readonly string[];
};

/** Trim, lower-case and drop one trailing dot. Does not validate. */
export function normaliseHostname(input: string): string {
  const trimmed = input.trim().toLowerCase();
  return trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
}

/** `theirgarage.co.uk` for `book.theirgarage.co.uk`; null when the name is itself a public suffix. */
export function registrableDomain(hostname: string): string | null {
  const labels = normaliseHostname(hostname).split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join(".");
  const needed = MULTI_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  if (labels.length < needed) return null;
  return labels.slice(-needed).join(".");
}

/** Platform domains: the built-in Vitalos roots plus the configured admin and tenant hosts. */
export function defaultPlatformDomains(): string[] {
  const configured = [process.env.NEXT_PUBLIC_TENANT_ROOT_DOMAIN, process.env.NEXT_PUBLIC_ADMIN_HOST]
    .map((value) => (value ? normaliseHostname(value.replace(/:\d+$/, "")) : ""))
    .filter((value) => value.includes(".") && value !== "localhost");
  return [...new Set([...DEFAULT_PLATFORM_DOMAINS, ...configured])];
}

/** True when the hostname is one of our own domains or sits under one (never add or remove these). */
export function isPlatformHostname(hostname: string, platformDomains: readonly string[] = defaultPlatformDomains()): boolean {
  const host = normaliseHostname(hostname);
  return platformDomains.some((root) => {
    const domain = normaliseHostname(root);
    return host === domain || host.endsWith(`.${domain}`);
  });
}

function reject(reason: HostnameRejection, message: string): HostnameValidation {
  return { ok: false, reason, message };
}

function toAscii(host: string): string | null {
  if (/^[\x00-\x7f]*$/.test(host)) return host;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Validate the web address a garage typed into Booking page settings.
 * Messages are written for the garage and can be shown as-is under the field.
 */
export function validateGarageHostname(input: string, options: HostnameValidationOptions = {}): HostnameValidation {
  const raw = normaliseHostname(input ?? "");
  if (!raw) return reject("empty", "Enter a web address, such as book.yourgarage.co.uk.");
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(raw) || raw.startsWith("//")) {
    return reject("has_scheme", "Enter just the address, without http:// or https://.");
  }
  if (/[/?#\\]/.test(raw)) return reject("has_path", "Enter just the address, without a / or anything after it.");
  if (/\s|@/.test(raw)) return reject("invalid_characters", "Web addresses can only use letters, numbers, dots and hyphens.");
  if (raw.startsWith("[") || (raw.match(/:/g)?.length ?? 0) > 1) {
    return reject("ip_address", "Enter a web address, not an IP address.");
  }
  if (raw.includes(":")) return reject("has_port", "Enter the address without a port number (the part after the colon).");
  if (raw.includes("*")) return reject("wildcard", "Enter one exact address, such as book.yourgarage.co.uk.");

  const host = toAscii(raw);
  if (!host) return reject("invalid_characters", "Web addresses can only use letters, numbers, dots and hyphens.");
  if (host.length > 253) return reject("too_long", "That web address is too long.");

  const labels = host.split(".");
  if (labels.some((label) => label.length === 0)) {
    return reject("invalid_characters", "That web address has an empty part (two dots together, or a dot at the start).");
  }
  if (labels.some((label) => label.length > 63)) return reject("too_long", "Each part of a web address must be 63 characters or fewer.");
  if (labels.some((label) => !LABEL.test(label))) {
    return reject("invalid_characters", "Web addresses can only use letters, numbers and hyphens between the dots, and can't start or end a part with a hyphen.");
  }
  if (labels.every((label) => /^\d+$/.test(label))) return reject("ip_address", "Enter a web address, not an IP address.");

  const tld = labels[labels.length - 1] ?? "";
  if (host === "localhost" || tld === "localhost") return reject("localhost", "localhost can't be used. Enter your garage's web address.");
  if (labels.length === 1) return reject("not_subdomain", "Enter a full web address, such as book.yourgarage.co.uk.");
  if (RESERVED_TLDS.has(tld)) return reject("reserved_tld", "That address ending isn't on the public internet. Enter your garage's web address.");
  if (!TLD.test(tld)) return reject("invalid_characters", "That doesn't end in a real domain ending, such as .co.uk or .com.");

  if (isPlatformHostname(host, options.platformDomains ?? defaultPlatformDomains())) {
    return reject("platform_domain", "That's a Pitline address. Your free link already works; enter your own domain here instead.");
  }
  if (HOSTED_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    return reject("not_owned", "That address belongs to a website service. Use a domain you own, such as book.yourgarage.co.uk.");
  }

  const apexName = registrableDomain(host);
  if (!apexName || apexName === host) {
    const example = apexName ? `book.${apexName}` : "book.yourgarage.co.uk";
    return reject("not_subdomain", `Use a subdomain such as ${example}, so your main website keeps working.`);
  }

  return { ok: true, hostname: host, apexName, subdomain: host.slice(0, -(apexName.length + 1)) };
}
