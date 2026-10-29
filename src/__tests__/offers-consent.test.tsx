// @vitest-environment jsdom

import type { SupabaseClient } from "@supabase/supabase-js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/booking-flow/actions", () => ({ confirmBookingAction: vi.fn() }));

import { DetailsStep } from "@/app/%5Fsite/[garageId]/_components/details-step";
import { REMINDER_CONSENT_COPY } from "@/components/book";
import { previewAudience } from "@/lib/campaigns/admin";
import { campaignAllowed, campaignConsentBasis, offersStatusText, type OffersConsentFields } from "@/lib/consent/offers";

// Consent wording v1.0: campaigns need offers consent (or the soft opt-in route), apart from
// reminder consent. The SQL rule (campaign_consent_basis()) has the same matrix in
// supabase/tests/database/039_offers_consent.test.sql.

const OFFERS = "Send me occasional offers from Hartley Road Motors. You can stop these any time.";

function customer(fields: Partial<OffersConsentFields> = {}): OffersConsentFields {
  return { offersConsent: false, reminderConsent: false, consentSource: null, offersOptedOutAt: null, ...fields };
}

describe("who campaigns may go to", () => {
  it("offers consent, or reminder consent by soft opt-in never opted out since", () => {
    const opted = "2026-10-01T10:00:00Z";
    const cases: Array<[Partial<OffersConsentFields>, string | null]> = [
      [{ offersConsent: true }, "offers"],
      [{ offersConsent: true, reminderConsent: true, consentSource: "soft_opt_in", offersOptedOutAt: opted }, "offers"],
      [{ reminderConsent: true, consentSource: "soft_opt_in" }, "soft_opt_in"],
      [{ reminderConsent: true, consentSource: "soft_opt_in", offersOptedOutAt: opted }, null],
      [{ reminderConsent: false, consentSource: "soft_opt_in" }, null],
      [{ reminderConsent: true, consentSource: "booking" }, null],
      [{ reminderConsent: true, consentSource: "import" }, null],
      [{ reminderConsent: true, consentSource: "staff" }, null],
      [{ reminderConsent: true, consentSource: "unsubscribe_page" }, null],
      [{}, null],
    ];
    for (const [fields, basis] of cases) expect(campaignConsentBasis(customer(fields)), JSON.stringify(fields)).toBe(basis);
  });

  it("never after an opt-out, and never to an anonymised customer", () => {
    const ticked = customer({ offersConsent: true });
    expect(campaignAllowed({ ...ticked, optedOutAt: null })).toBe(true);
    expect(campaignAllowed({ ...ticked, optedOutAt: "2026-10-29T09:00:00Z" })).toBe(false);
    expect(campaignAllowed({ ...ticked, optedOutAt: null, anonymisedAt: "2026-10-29T09:00:00Z" })).toBe(false);
    expect(campaignAllowed({ ...customer({ reminderConsent: true, consentSource: "booking" }), optedOutAt: null })).toBe(false);
  });

  it("tells staff where offers stand, and that only the customer can give them", () => {
    expect(offersStatusText({ ...customer({ offersConsent: true }), optedOutAt: null })).toMatch(/ticked the offers box/);
    expect(offersStatusText({ ...customer({ reminderConsent: true, consentSource: "soft_opt_in" }), optedOutAt: null })).toMatch(/soft opt-in/);
    expect(offersStatusText({ ...customer({ reminderConsent: true, consentSource: "booking" }), optedOutAt: null })).toBe(
      "No offers consent, so no campaigns are sent. Only the customer can give it, by ticking the offers box when they book.",
    );
    expect(offersStatusText({ ...customer({ offersConsent: true }), optedOutAt: "2026-10-29T09:00:00Z" })).toMatch(/^Opted out/);
  });
});

describe("the details step's offers box", () => {
  function renderStep() {
    return render(<DetailsStep summary={null} motEnabled garageName="Hartley Road Motors" needsApproval={false} humanCheck={false} />);
  }

  it("is a second, unticked checkbox with the approved wording and the garage's name", () => {
    renderStep();
    const reminders = screen.getByRole("checkbox", { name: REMINDER_CONSENT_COPY });
    const offers = screen.getByRole("checkbox", { name: OFFERS });
    expect(reminders).not.toBe(offers);
    expect(reminders).not.toBeChecked();
    expect(offers).not.toBeChecked();
    expect(offers).toHaveAttribute("name", "offersConsent");
    expect(reminders).toHaveAttribute("name", "reminderConsent");
  });

  it("sends offersConsent=yes only when ticked, independently of reminders", async () => {
    const user = userEvent.setup();
    const { container } = renderStep();
    const form = container.querySelector("form")!;
    expect(new FormData(form).get("offersConsent")).toBeNull();

    await user.click(screen.getByRole("checkbox", { name: OFFERS }));
    let data = new FormData(form);
    expect(data.get("offersConsent")).toBe("yes");
    expect(data.get("reminderConsent")).toBeNull();

    await user.click(screen.getByRole("checkbox", { name: REMINDER_CONSENT_COPY }));
    await user.click(screen.getByRole("checkbox", { name: OFFERS }));
    data = new FormData(form);
    expect(data.get("offersConsent")).toBeNull();
    expect(data.get("reminderConsent")).toBe("yes");
  });
});

describe("the campaign audience preview", () => {
  it("reads how many ticked offers and why each customer is in", async () => {
    const rows = [
      { total: 3, offers_total: 2, customer_id: "c1", customer_name: "Ava", phone: "+447700900111", email: null, channel: "sms", registration: "AB12CDE", make: "Ford", model: "Focus", last_visit: null, consent_basis: "offers" },
      { total: 3, offers_total: 2, customer_id: "c2", customer_name: "Gus", phone: "+447700900222", email: null, channel: "whatsapp", registration: "CD34EFG", make: null, model: null, last_visit: null, consent_basis: "soft_opt_in" },
    ];
    const rpc = vi.fn(async () => ({ data: rows, error: null }));
    const result = await previewAudience({ rpc } as unknown as SupabaseClient, {}, 8);
    expect(rpc).toHaveBeenCalledWith("preview_campaign_audience", { p_segment: {}, p_limit: 8 });
    expect(result).toMatchObject({
      ok: true,
      preview: {
        total: 3,
        offersTotal: 2,
        rows: [
          { customerId: "c1", basis: "offers", contact: "07••• •••111" },
          { customerId: "c2", basis: "soft_opt_in", channel: "whatsapp" },
        ],
      },
    });
  });

  it("is empty when nobody matches", async () => {
    const rpc = vi.fn(async () => ({ data: [{ total: 0, offers_total: 0, customer_id: null }], error: null }));
    expect(await previewAudience({ rpc } as unknown as SupabaseClient, {}, 8)).toEqual({ ok: true, preview: { total: 0, offersTotal: 0, rows: [] } });
  });
});
