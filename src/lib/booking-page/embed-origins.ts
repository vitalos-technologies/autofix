/**
 * Sites allowed to show a garage's booking page in an iframe (P4.3).
 *
 * Pure and client-safe: the settings form, the server action and the proxy (which turns the list
 * into `Content-Security-Policy: frame-ancestors`) all use it. Stored as `garages.settings.embedOrigins`.
 */

export const MAX_EMBED_ORIGINS = 10;

export type EmbedOriginsResult =
  | { ok: true; origins: string[] }
  | { ok: false; message: string };

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * One allowed site as an `https://host[:port]` origin, lower case, or `null` when it is not one.
 * A bare host (`www.theirgarage.co.uk`) is read as https. Paths, queries, wildcards, credentials,
 * IP addresses and `http:` are refused: a CSP source with any of them either does nothing or opens
 * the page to far more sites than the garage meant.
 */
export function normaliseEmbedOrigin(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" || /^[a-z]+:\/\/[^/]+\/./i.test(value)) return null;
  if (value.includes("*")) return null;
  const host = url.hostname.toLowerCase();
  if (host.length > 253 || /^[0-9.]+$/.test(host) || host.startsWith("[")) return null;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label)) || !/^[a-z]{2,63}$|^xn--/.test(labels.at(-1) ?? "")) return null;
  return url.port ? `https://${host}:${url.port}` : `https://${host}`;
}

/** The form's textarea (one site per line, or comma separated) → a validated, de-duplicated list. */
export function parseEmbedOrigins(text: string): EmbedOriginsResult {
  const entries = text.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean);
  const origins: string[] = [];
  for (const entry of entries) {
    const origin = normaliseEmbedOrigin(entry);
    if (!origin) {
      return { ok: false, message: `${entry.slice(0, 80)} isn't a website address we can allow. Enter addresses like https://www.yourgarage.co.uk, one per line.` };
    }
    if (!origins.includes(origin)) origins.push(origin);
  }
  if (origins.length > MAX_EMBED_ORIGINS) return { ok: false, message: `You can allow up to ${MAX_EMBED_ORIGINS} websites.` };
  return { ok: true, origins };
}

/** Stored origins, re-validated (anything malformed in `settings` is dropped, never trusted). */
export function embedOriginsFromSettings(settings: unknown): string[] {
  const raw = settings && typeof settings === "object" ? (settings as Record<string, unknown>).embedOrigins : null;
  if (!Array.isArray(raw)) return [];
  const origins: string[] = [];
  for (const entry of raw) {
    const origin = typeof entry === "string" ? normaliseEmbedOrigin(entry) : null;
    if (origin && !origins.includes(origin)) origins.push(origin);
    if (origins.length === MAX_EMBED_ORIGINS) break;
  }
  return origins;
}
