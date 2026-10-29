/**
 * Who may get campaigns (offers), consent wording v1.0 ("Campaigns (offers)" in
 * docs/autofix/legal/consent-and-messaging-wording.md). Pure and client-safe.
 *
 * The database decides the real audience: campaign_consent_basis() in
 * supabase/migrations/20261029001400_offers_consent.sql, used by campaign_audience(),
 * claim_campaign_sends() and the cancel trigger. This mirrors it for the admin
 * pages and the tests.
 */

/** Why a campaign may go to a customer: they ticked the offers box, or the soft opt-in route. */
export type CampaignConsentBasis = "offers" | "soft_opt_in";

export type OffersConsentFields = {
  offersConsent: boolean;
  reminderConsent: boolean;
  /** `customers.consent_source` (the reminder consent's source). */
  consentSource: string | null;
  /** The latest opt-out, kept after START or "Turn reminders back on" clear `optedOutAt`. */
  offersOptedOutAt: string | null;
};

/**
 * `offers` when the customer ticked the offers box; `soft_opt_in` when their reminder consent is
 * the soft opt-in route and they have not opted out since; otherwise null. Reminder consent from
 * a booking, an import, staff or the unsubscribe page is not enough.
 */
export function campaignConsentBasis(customer: OffersConsentFields): CampaignConsentBasis | null {
  if (customer.offersConsent) return "offers";
  if (customer.reminderConsent && customer.consentSource === "soft_opt_in" && !customer.offersOptedOutAt) return "soft_opt_in";
  return null;
}

/** Whether a campaign may go to the customer now: a basis, not opted out, not anonymised. */
export function campaignAllowed(customer: OffersConsentFields & { optedOutAt: string | null; anonymisedAt?: string | null }): boolean {
  return !customer.optedOutAt && !customer.anonymisedAt && campaignConsentBasis(customer) !== null;
}

/** How the admin names each basis (audience preview, customer page). */
export const CAMPAIGN_CONSENT_LABELS: Record<CampaignConsentBasis, string> = {
  offers: "Ticked offers",
  soft_opt_in: "Soft opt-in",
};

/** The customer page's line about offers, for staff (read-only: only the customer can tick the box). */
export function offersStatusText(customer: OffersConsentFields & { optedOutAt: string | null }): string {
  if (customer.optedOutAt) return "Opted out, so no offers are sent either.";
  const basis = campaignConsentBasis(customer);
  if (basis === "offers") return "Gets offers (campaigns): they ticked the offers box when booking.";
  if (basis === "soft_opt_in") return "Gets offers for services like those they've had (soft opt-in as an existing customer).";
  return "No offers consent, so no campaigns are sent. Only the customer can give it, by ticking the offers box when they book.";
}

/** Narrows a database value to a basis (anything else is null). */
export function parseCampaignConsentBasis(value: unknown): CampaignConsentBasis | null {
  return value === "offers" || value === "soft_opt_in" ? value : null;
}
