/**
 * Host classification for multi-tenant routing (SPEC "Multi-tenancy and domains").
 * Pure: no I/O, so the proxy and server helpers share one tested implementation.
 */

export type HostKind =
  | { kind: "admin" }
  | { kind: "subdomain"; slug: string }
  | { kind: "dev-garage"; slug: string }
  | { kind: "custom"; hostname: string }
  | { kind: "unknown" };

export type HostEnvironment = {
  [name: string]: string | undefined;
  NEXT_PUBLIC_ADMIN_HOST?: string;
  NEXT_PUBLIC_TENANT_ROOT_DOMAIN?: string;
  DEV_TENANT_ROOT_DOMAIN?: string;
  VERCEL_ENV?: string;
  VERCEL_URL?: string;
  VERCEL_BRANCH_URL?: string;
};

const DEFAULT_ADMIN_HOST = "autofix.vitalos.co.uk";
const DEFAULT_TENANT_ROOT = "autofix.vitalos.co.uk";

/** Labels under the tenant root that can never be a garage slug. */
export const RESERVED_SLUGS = new Set([
  "admin", "api", "app", "assets", "auth", "billing", "book", "cdn", "dashboard", "dev", "docs", "help",
  "mail", "ns1", "ns2", "platform", "smtp", "staging", "static", "status", "support", "test", "www",
]);

const SLUG_PATTERN = /^[a-z0-9](?:-?[a-z0-9])*$/;
const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidSlug(slug: string) {
  return slug.length >= 3 && slug.length <= 40 && SLUG_PATTERN.test(slug) && !RESERVED_SLUGS.has(slug);
}

/** Lower-cases a Host header value and drops default ports and a trailing dot. */
export function normaliseHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let host = raw.trim().toLowerCase();
  if (!host || host.length > 260 || /[\s/\\@?#]/.test(host)) return null;
  if (host.endsWith(":80") || host.endsWith(":443")) host = host.slice(0, host.lastIndexOf(":"));
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host || null;
}

function splitPort(host: string) {
  const index = host.lastIndexOf(":");
  if (index === -1 || host.startsWith("[")) return { name: host, port: null as string | null };
  const port = host.slice(index + 1);
  return /^\d{1,5}$/.test(port) ? { name: host.slice(0, index), port } : { name: host, port: null };
}

function isLoopbackName(name: string) {
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]";
}

function isPublicHostname(name: string) {
  if (name.length > 253 || /^\d+(\.\d+){3}$/.test(name)) return false;
  const labels = name.split(".");
  if (labels.length < 2) return false;
  return labels.every((label) => LABEL_PATTERN.test(label)) && /^[a-z]{2,63}$/.test(labels[labels.length - 1] ?? "");
}

/** Dev hosts (`localhost`, `<slug>.localhost`) work everywhere except Vercel production. */
function devHostsEnabled(env: HostEnvironment) {
  return env.VERCEL_ENV !== "production";
}

/**
 * Decides which surface a request host serves.
 * `devGarageParam` is the `?__garage=<slug>` query value, honoured only on dev hosts.
 */
export function classifyHost(
  rawHost: string | null | undefined,
  env: HostEnvironment = process.env,
  devGarageParam?: string | null,
): HostKind {
  const host = normaliseHost(rawHost);
  if (!host) return { kind: "unknown" };

  const adminHost = normaliseHost(env.NEXT_PUBLIC_ADMIN_HOST) ?? DEFAULT_ADMIN_HOST;
  const tenantRoot = normaliseHost(env.NEXT_PUBLIC_TENANT_ROOT_DOMAIN) ?? DEFAULT_TENANT_ROOT;
  const { name } = splitPort(host);

  if (devHostsEnabled(env)) {
    const devRootName = splitPort(normaliseHost(env.DEV_TENANT_ROOT_DOMAIN) ?? "localhost").name;
    if (name === devRootName || isLoopbackName(name)) {
      const slug = devGarageParam?.trim().toLowerCase();
      if (slug) return isValidSlug(slug) ? { kind: "dev-garage", slug } : { kind: "unknown" };
      return { kind: "admin" };
    }
    for (const root of new Set([devRootName, "localhost"])) {
      if (name.endsWith(`.${root}`)) {
        const label = name.slice(0, -(root.length + 1));
        return isValidSlug(label) ? { kind: "dev-garage", slug: label } : { kind: "unknown" };
      }
    }
  }

  if (host === adminHost) return { kind: "admin" };
  for (const deploymentHost of [env.VERCEL_URL, env.VERCEL_BRANCH_URL]) {
    if (deploymentHost && host === normaliseHost(deploymentHost)) return { kind: "admin" };
  }

  if (host.endsWith(`.${tenantRoot}`)) {
    const label = host.slice(0, -(tenantRoot.length + 1));
    return isValidSlug(label) ? { kind: "subdomain", slug: label } : { kind: "unknown" };
  }

  // Custom garage domains never carry a port and are never our own root.
  if (host === tenantRoot || splitPort(host).port || !isPublicHostname(name)) return { kind: "unknown" };
  return { kind: "custom", hostname: name };
}

/** Builds the free-link host for a garage slug, e.g. `hartley-road.autofix.vitalos.co.uk`. */
export function freeLinkHost(slug: string, env: HostEnvironment = process.env) {
  const tenantRoot = normaliseHost(env.NEXT_PUBLIC_TENANT_ROOT_DOMAIN) ?? DEFAULT_TENANT_ROOT;
  return `${slug}.${tenantRoot}`;
}
