/**
 * Askbridge chat on a garage's booking pages (P4.6): per-garage setting and the widget script location.
 * Pure and client-safe (no secrets here). Contract: `docs/autofix/askbridge.md`.
 *
 * Per garage: `garages.settings.askbridge = { enabled: boolean, siteKey: string | null }`, set by the owner
 * on /app/settings/booking-page. The site key comes from the garage's own Askbridge workspace. Platform:
 * `NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL`, the loader script (Askbridge's own when unset).
 */

export type AskbridgeSettings = { enabled: boolean; siteKey: string | null };

export type AskbridgeWidget = { scriptUrl: string; origin: string; siteKey: string };

type Env = Readonly<Record<string, string | undefined>>;

/** Askbridge's loader, as its install snippet gives it. */
export const ASKBRIDGE_DEFAULT_SCRIPT_URL = "https://askbridge.vitalos.co.uk/widget/v1/askbridge.js";

/** An Askbridge site key: `pk_` and 32 lower-case hex characters (Askbridge `app.sites.site_key`). */
export const ASKBRIDGE_SITE_KEY = /^pk_[0-9a-f]{32}$/;

export function parseAskbridgeSiteKey(raw: unknown): string | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  return ASKBRIDGE_SITE_KEY.test(value) ? value : null;
}

/** `settings.askbridge`, re-validated: enabled only with a well-formed site key. */
export function askbridgeFromSettings(settings: unknown): AskbridgeSettings {
  const raw = settings && typeof settings === "object" ? (settings as Record<string, unknown>).askbridge : null;
  if (!raw || typeof raw !== "object") return { enabled: false, siteKey: null };
  const value = raw as Record<string, unknown>;
  const siteKey = parseAskbridgeSiteKey(value.siteKey);
  return { enabled: value.enabled === true && siteKey !== null, siteKey };
}

function isLoopback(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost");
}

/**
 * The loader URL: `NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL`, or Askbridge's own when unset. https only, except a
 * loopback stub (`http://127.0.0.1:…`) anywhere but a Vercel production deployment: the local production
 * build that Playwright and Lighthouse run serves one. `null` when the value is set but invalid, so a
 * misconfiguration hides the chat rather than loading something else.
 */
export function askbridgeScriptUrl(env: Env = { NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL: process.env.NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL, VERCEL_ENV: process.env.VERCEL_ENV }): URL | null {
  const raw = env.NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL?.trim() || ASKBRIDGE_DEFAULT_SCRIPT_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && env.VERCEL_ENV !== "production" && isLoopback(url.hostname)) return url;
  return null;
}

/**
 * What a booking page needs to load the chat, or `null` when this garage should not load it. The loader
 * calls Askbridge's API on its own origin (no `data-api`), so `origin` is all the CSP has to allow.
 */
export function askbridgeWidgetFor(settings: unknown, env?: Env): AskbridgeWidget | null {
  const askbridge = askbridgeFromSettings(settings);
  if (!askbridge.enabled || !askbridge.siteKey) return null;
  const url = askbridgeScriptUrl(env);
  if (!url) return null;
  return { scriptUrl: url.toString(), origin: url.origin, siteKey: askbridge.siteKey };
}

/**
 * The website addresses a garage adds to its Askbridge workspace as allowed websites: its free link and,
 * once connected, its own address. Askbridge matches exact origins (no wildcards).
 */
export function askbridgeAllowedOrigins(freeLinkOrigin: string, customHostname?: string | null): string[] {
  const origins = [freeLinkOrigin.replace(/\/+$/, "")];
  const custom = customHostname?.trim().toLowerCase();
  if (custom) origins.push(`https://${custom}`);
  return [...new Set(origins)];
}
