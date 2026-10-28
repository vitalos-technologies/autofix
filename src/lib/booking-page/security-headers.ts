/**
 * Security headers that depend on the host (P4.3, P4.6). Set by `src/proxy.ts`; `next.config.ts`
 * keeps the headers that are the same everywhere.
 *
 * - Admin host (and 404s): `X-Frame-Options: SAMEORIGIN` + `frame-ancestors 'self'`.
 * - Garage booking host: no `X-Frame-Options`; a CSP whose `frame-ancestors` lists the sites the
 *   garage allowed (`garages.settings.embedOrigins`), and which lets the Askbridge widget's origin
 *   load scripts, frames and connections only when the garage has the widget on.
 *
 * Pure (no I/O) so every shape is unit tested.
 */

/** Cloudflare Turnstile (booking form) loads its script and challenge frame from here. */
const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

export type BookingSiteHeaderInput = {
  /** Validated https origins (see `embedOriginsFromSettings`). */
  embedOrigins?: readonly string[];
  /** Origin of the Askbridge widget script when this garage has it on; otherwise null. */
  widgetOrigin?: string | null;
  /** `next dev` needs eval and its HMR websocket. */
  dev?: boolean;
};

export const ADMIN_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Frame-Options": "SAMEORIGIN",
  "Content-Security-Policy": "frame-ancestors 'self'",
};

function sources(...lists: Array<ReadonlyArray<string | null | undefined>>) {
  return [...new Set(lists.flat().filter((value): value is string => Boolean(value)))].join(" ");
}

export function bookingSiteCsp({ embedOrigins = [], widgetOrigin = null, dev = false }: BookingSiteHeaderInput): string {
  const widget = widgetOrigin ? [widgetOrigin] : [];
  const directives = [
    "default-src 'self'",
    `script-src ${sources(["'self'", "'unsafe-inline'"], dev ? ["'unsafe-eval'"] : [], [TURNSTILE_ORIGIN], widget)}`,
    "style-src 'self' 'unsafe-inline'",
    // Garage logos live in Supabase Storage; the widget may show its own images.
    `img-src ${sources(["'self'", "data:", "blob:", "https:"], dev ? ["http:"] : [])}`,
    // Health check videos (P5.3) play from short-lived signed Supabase Storage URLs (local Supabase is http in dev).
    `media-src ${sources(["'self'", "blob:", "https:"], dev ? ["http:"] : [])}`,
    "font-src 'self' data:",
    `connect-src ${sources(["'self'", TURNSTILE_ORIGIN], widget, dev ? ["ws:", "wss:"] : [])}`,
    `frame-src ${sources(["'self'", TURNSTILE_ORIGIN], widget)}`,
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
