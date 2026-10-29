/**
 * The addresses Pitline had as Autofix (DECISIONS D22): the admin host `autofix.vitalos.co.uk` and the
 * free links `<slug>.autofix.vitalos.co.uk`. Each answers with a permanent redirect to the same path and
 * query on the configured admin host or tenant root. Webhook and cron paths are served where they land:
 * Twilio, Stripe and Resend keep posting to the old host until each is switched over.
 * Nothing redirects while the old root is still the configured one, so this ships before the env switch.
 * Pure: no I/O.
 */
import { configuredAdminHost, configuredTenantRoot, isValidSlug, normaliseHost, type HostEnvironment } from "@/lib/tenancy/hosts";

export const LEGACY_ROOT_DOMAIN = "autofix.vitalos.co.uk";

/** Paths never redirected from the old hosts (third parties post to them). */
export const LEGACY_KEPT_PREFIXES = ["/api/webhooks", "/api/cron"] as const;

export type LegacyHostDecision =
  | { kind: "redirect"; location: string }
  /** An old host on a kept path: serve it as the admin host would. */
  | { kind: "serve" };

function hasPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** The new host for an old one, or null when `host` is not an old address (or the old root is still live). */
function newHostFor(host: string, env: HostEnvironment) {
  if (host === LEGACY_ROOT_DOMAIN) {
    const adminHost = configuredAdminHost(env);
    return adminHost === LEGACY_ROOT_DOMAIN ? null : adminHost;
  }
  if (!host.endsWith(`.${LEGACY_ROOT_DOMAIN}`)) return null;
  const tenantRoot = configuredTenantRoot(env);
  const slug = host.slice(0, -(LEGACY_ROOT_DOMAIN.length + 1));
  return tenantRoot === LEGACY_ROOT_DOMAIN || !isValidSlug(slug) ? null : `${slug}.${tenantRoot}`;
}

/** What to do with a request on an old Autofix address; null for every other host. */
export function legacyHostDecision(
  requestUrl: string | URL,
  rawHost: string | null | undefined,
  env: HostEnvironment = process.env,
): LegacyHostDecision | null {
  const host = normaliseHost(rawHost);
  const target = host ? newHostFor(host, env) : null;
  if (!target) return null;

  const url = new URL(requestUrl);
  if (LEGACY_KEPT_PREFIXES.some((prefix) => hasPrefix(url.pathname, prefix))) return { kind: "serve" };
  url.protocol = "https:";
  url.hostname = target;
  url.port = "";
  return { kind: "redirect", location: url.toString() };
}
