/**
 * Askbridge AI front desk: per-garage widget settings and the widget script location (P4.6).
 * Pure and client-safe (no secrets here). Contract: `docs/autofix/askbridge.md`.
 *
 * Per garage: `garages.settings.askbridge = { enabled: boolean, widgetId: string }` (owners set it on
 * /app/settings/booking-page). Platform: `NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL`, the widget script.
 */

export type AskbridgeSettings = { enabled: boolean; widgetId: string | null };

export type AskbridgeWidget = { scriptUrl: string; origin: string; widgetId: string };

type Env = Readonly<Record<string, string | undefined>>;

/** Askbridge widget ids: letters, digits, `_` and `-`, 4–64 characters. */
export const ASKBRIDGE_WIDGET_ID = /^[A-Za-z0-9_-]{4,64}$/;

export function parseAskbridgeWidgetId(raw: unknown): string | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  return ASKBRIDGE_WIDGET_ID.test(value) ? value : null;
}

/** `settings.askbridge`, re-validated: enabled only with a well-formed widget id. */
export function askbridgeFromSettings(settings: unknown): AskbridgeSettings {
  const raw = settings && typeof settings === "object" ? (settings as Record<string, unknown>).askbridge : null;
  if (!raw || typeof raw !== "object") return { enabled: false, widgetId: null };
  const value = raw as Record<string, unknown>;
  const widgetId = parseAskbridgeWidgetId(value.widgetId);
  return { enabled: value.enabled === true && widgetId !== null, widgetId };
}

function isLoopback(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost");
}

/**
 * The widget script URL from `NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL`: https only, except a loopback stub
 * (`http://127.0.0.1:…`) anywhere but a Vercel production deployment: the local production build that
 * Playwright and Lighthouse run serves one. `null` when unset or invalid.
 */
export function askbridgeScriptUrl(env: Env = { NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL: process.env.NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL, VERCEL_ENV: process.env.VERCEL_ENV }): URL | null {
  const raw = env.NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL?.trim();
  if (!raw) return null;
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

/** What a booking page needs to load the widget, or `null` when this garage should not load it. */
export function askbridgeWidgetFor(settings: unknown, env?: Env): AskbridgeWidget | null {
  const askbridge = askbridgeFromSettings(settings);
  if (!askbridge.enabled || !askbridge.widgetId) return null;
  const url = askbridgeScriptUrl(env);
  if (!url) return null;
  return { scriptUrl: url.toString(), origin: url.origin, widgetId: askbridge.widgetId };
}
