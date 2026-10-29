/**
 * Security headers that depend on the host (P4.3, P4.6). Set by `src/proxy.ts`; `next.config.ts`
 * keeps the headers that are the same everywhere.
 *
 * - Admin host (and 404s): `X-Frame-Options: SAMEORIGIN` + `frame-ancestors 'self'`.
 * - Garage booking host: no `X-Frame-Options`; a CSP whose `frame-ancestors` lists the sites the
 *   garage allowed (`garages.settings.embedOrigins`), and which lets the Askbridge loader's origin
 *   load scripts and take connections only when the garage has the chat on. The loader fetches its
 *   panel and calls its API on that same origin; its only frame and extra script are Turnstile's,
 *   which every booking page already allows, and its logo is an https image.
 *
 * Pure (no I/O) so every shape is unit tested.
 */

/** Cloudflare Turnstile (booking form and the Askbridge chat) loads its script and challenge frame from here. */
const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

export type BookingSiteHeaderInput = {
  /** Validated https origins (see `embedOriginsFromSettings`). */
  embedOrigins?: readonly string[];
  /** Origin of the Askbridge loader (and its API) when this garage has the chat on; otherwise null. */
  widgetOrigin?: string | null;
  /** `next dev` needs eval and its HMR websocket. */
  dev?: boolean;
  /**
   * P5.3: the Supabase Storage origin, for health check photos and videos on signed URLs (needed when it
   * is not https, as the local stack is; https origins are already allowed).
   */
  storageOrigin?: string | null;
};

export const ADMIN_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Frame-Options": "SAMEORIGIN",
  "Content-Security-Policy": "frame-ancestors 'self'",
};

function sources(...lists: Array<ReadonlyArray<string | null | undefined>>) {
  return [...new Set(lists.flat().filter((value): value is string => Boolean(value)))].join(" ");
}

export function bookingSiteCsp({ embedOrigins = [], widgetOrigin = null, dev = false, storageOrigin = null }: BookingSiteHeaderInput): string {
  const widget = widgetOrigin ? [widgetOrigin] : [];
  const directives = [
    "default-src 'self'",
    `script-src ${sources(["'self'", "'unsafe-inline'"], dev ? ["'unsafe-eval'"] : [], [TURNSTILE_ORIGIN], widget)}`,
    "style-src 'self' 'unsafe-inline'",
    // Garage logos live in Supabase Storage; the Askbridge launcher shows the workspace logo (https).
    `img-src ${sources(["'self'", "data:", "blob:", "https:"], [storageOrigin])}`,
    // Health check videos (P5.3) play from short-lived signed Supabase Storage URLs.
    `media-src ${sources(["'self'", "blob:", "https:"], [storageOrigin])}`,
    "font-src 'self' data:",
    `connect-src ${sources(["'self'", TURNSTILE_ORIGIN], widget, dev ? ["ws:", "wss:"] : [])}`,
    `frame-src ${sources(["'self'", TURNSTILE_ORIGIN])}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${sources(["'self'"], embedOrigins)}`,
  ];
  return directives.join("; ");
}

/** Headers for a garage booking host response (no `X-Frame-Options`: the CSP decides framing). */
export function bookingSiteHeaders(input: BookingSiteHeaderInput): Record<string, string> {
  return { "Content-Security-Policy": bookingSiteCsp(input) };
}
