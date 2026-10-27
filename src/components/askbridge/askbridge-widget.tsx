"use client";

import Script from "next/script";

export type AskbridgeWidgetProps = {
  /** Validated script URL (`askbridgeScriptUrl()`); the CSP allows its origin only for this garage. */
  src: string;
  widgetId: string;
  garageName: string;
  /** Garage accent, for the launcher. */
  accent: string;
};

/**
 * Askbridge chat on a garage's booking pages (P4.6). Loaded with `lazyOnload` (after the page has
 * loaded, when the browser is idle), so it is never on the critical path; the widget draws its own
 * fixed-position launcher, so nothing on the page moves. Contract: `docs/autofix/askbridge.md`.
 * Chats that end in a booking send the customer to `data-booking-url` (the first step) and never
 * put a registration in the address.
 */
export function AskbridgeWidget({ src, widgetId, garageName, accent }: AskbridgeWidgetProps) {
  return (
    <Script
      id="askbridge-widget"
      src={src}
      strategy="lazyOnload"
      data-widget-id={widgetId}
      data-garage-name={garageName}
      data-accent={accent}
      data-booking-url="/"
    />
  );
}
