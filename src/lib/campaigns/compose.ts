// Campaign message composition (P5.5): the campaign's wording with the customer's, car's and
// garage's details. Texts and WhatsApp end with "Reply STOP to opt out." (renderTemplate adds it;
// sent from the garage's two-way number, DECISIONS A13), emails use the email wording (or the text
// wording) with the subject and the signed "Stop reminders: <link>" line. Pure.

import { UNSUBSCRIBE_LINK_LINE } from "@/lib/consent/copy";
import type { ChannelKind } from "@/lib/messaging/channel";
import { renderTemplate, type TemplatePlaceholder } from "@/lib/messaging/templates";
import { firstName, vehicleLabel } from "@/lib/reminders/compose";
import { formatRegistration } from "@/lib/vehicle/registration-format";

/** One row of claim_campaign_sends() (docs/autofix/phase-5/P5.5-campaigns.md). */
export type ClaimedCampaignSend = {
  id: string;
  campaign_id: string;
  channel: ChannelKind;
  send_at: string;
  template: string;
  email_subject: string;
  email_template: string | null;
  service_id: string | null;
  customer_id: string;
  customer_name: string | null;
  phone: string | null;
  email: string | null;
  vehicle_id: string;
  registration: string;
  make: string | null;
  model: string | null;
};

export type ComposedCampaign =
  | { ok: true; body: string; subject?: string }
  | { ok: false; reason: "template_placeholders"; missing: TemplatePlaceholder[]; unknown: string[] };

export function composeCampaign(input: {
  send: Pick<ClaimedCampaignSend, "channel" | "template" | "email_subject" | "email_template" | "customer_name" | "registration" | "make" | "model">;
  garageName: string;
  /** Absolute `/c/{token}` link on the garage's booking host. */
  link: string;
  /** Email only: the customer's signed unsubscribe link (or the garage's unsubscribe form). */
  unsubscribeUrl?: string;
}): ComposedCampaign {
  const { send } = input;
  const vars = {
    first_name: firstName(send.customer_name),
    vehicle: vehicleLabel(send.make, send.model),
    reg: formatRegistration(send.registration),
    link: input.link,
    garage: input.garageName,
  };
  const email = send.channel === "email";
  const wording = email ? send.email_template?.trim() || send.template : send.template;
  const rendered = renderTemplate(wording, vars, { channel: send.channel });
  if (rendered.missingPlaceholders.length > 0 || rendered.unknownPlaceholders.length > 0) {
    return { ok: false, reason: "template_placeholders", missing: rendered.missingPlaceholders, unknown: rendered.unknownPlaceholders };
  }
  if (!email) return { ok: true, body: rendered.text };

  const subject = renderTemplate(send.email_subject, vars).text;
  const footer = input.unsubscribeUrl ? `\n\n${UNSUBSCRIBE_LINK_LINE.replace("{unsubscribe_link}", input.unsubscribeUrl)}` : "";
  return { ok: true, body: `${rendered.text}${footer}`, subject };
}
