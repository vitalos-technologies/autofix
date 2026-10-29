"use client";

import Script from "next/script";

export type AskbridgeWidgetProps = {
  /** Validated loader URL (`askbridgeScriptUrl()`); the CSP allows its origin only for this garage. */
  src: string;
  /** The garage's Askbridge site key (`pk_…`). */
  siteKey: string;
};

/**
 * Askbridge chat on a garage's booking pages (P4.6): Askbridge's own install snippet,
 * `<script src="…/widget/v1/askbridge.js" data-site="pk_…" async>`. The loader reads only `data-site`
 * (and an optional `data-api` we do not set, so it calls the API on the script's origin); theme, greeting
 * and the rest come from the garage's Askbridge workspace. Loaded with `lazyOnload` (after the page has
 * loaded, when the browser is idle), so it is never on the critical path; the widget draws its own
 * fixed-position launcher in a shadow root, so nothing on the page moves. Contract: `docs/autofix/askbridge.md`.
 */
export function AskbridgeWidget({ src, siteKey }: AskbridgeWidgetProps) {
  return <Script id="askbridge-widget" src={src} strategy="lazyOnload" async data-site={siteKey} />;
}
