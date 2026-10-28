import "server-only";

import { recordAdminAudit } from "@/lib/admin/audit";
import { maskEmail, maskMobile } from "@/lib/booking-flow/copy";
import { getChannel, type ChannelKind, type MessageChannel } from "@/lib/messaging/channel";
import { consumeRateLimit } from "@/lib/rate-limit";
import { TEST_PREFIX, TEST_RATE_LIMIT, testRecipient } from "@/lib/reminders/test-send";
import { garageBaseUrl, type GarageUrlSubject, type UrlEnvironment } from "@/lib/tenancy/urls";
import { composeCampaign } from "./compose";
import { campaignSampleValues, checkCampaignTemplate } from "./templates";

// "Send me a test" on a campaign (P5.5), like the Reminders page's (src/lib/reminders/test-send.ts):
// the saved wording with the sample details goes to the signed-in member's own mobile (else their
// own email), never to a customer or an address typed into the form. Mock outbox unless
// MESSAGING_MODE=live. At most 5 tests per member per 10 minutes (shared with reminder tests).
// Audited `campaign.test_sent` with the channel and outcome only. Not stored in `messages` or
// `campaign_sends`, and the send window does not apply (the member asked for it, to themselves).

export type CampaignTestInput = {
  garage: GarageUrlSubject & { id: string; name: string };
  user: { id: string; email?: string | null; phone?: string | null };
  campaign: { id: string; template: string; emailSubject: string; emailTemplate: string | null };
  channelFor?: (kind: ChannelKind) => MessageChannel;
  rateLimit?: (identifier: string, scope: string, limit: number, windowSeconds: number) => Promise<boolean>;
  audit?: typeof recordAdminAudit;
  env?: UrlEnvironment & Record<string, string | undefined>;
};

export type CampaignTestResult =
  | { ok: true; channel: ChannelKind; to: string; mode: "mock" | "live" }
  | { ok: false; code: "rate_limited" | "no_address" | "template" | "configuration_required" | "failed" };

export async function sendCampaignTest(input: CampaignTestInput): Promise<CampaignTestResult> {
  const audit = input.audit ?? recordAdminAudit;
  const record = async (outcome: string, channel?: ChannelKind) => {
    try {
      await audit(input.garage.id, {
        actorId: input.user.id,
        action: "campaign.test_sent",
        entityType: "campaign",
        entityId: input.campaign.id,
        detail: { outcome, ...(channel ? { channel } : {}) },
      });
    } catch {
      // A record, not a gate, for a test to the member themselves.
    }
  };

  if (!(await (input.rateLimit ?? consumeRateLimit)(input.user.id, "reminder_test", TEST_RATE_LIMIT.limit, TEST_RATE_LIMIT.windowSeconds))) {
    await record("rate_limited");
    return { ok: false, code: "rate_limited" };
  }
  if (!checkCampaignTemplate(input.campaign.template).ok) {
    await record("template");
    return { ok: false, code: "template" };
  }
  const recipient = testRecipient(input.user, { kind: "service", channel: "customer" });
  if (!recipient) {
    await record("no_address");
    return { ok: false, code: "no_address" };
  }

  const base = garageBaseUrl(input.garage, input.env);
  const sample = campaignSampleValues({ garageName: input.garage.name, bookingBaseUrl: base });
  const composed = composeCampaign({
    send: {
      channel: recipient.channel,
      template: input.campaign.template,
      email_subject: input.campaign.emailSubject,
      email_template: input.campaign.emailTemplate,
      customer_name: String(sample.first_name),
      registration: String(sample.reg),
      make: "Toyota",
      model: "Yaris",
    },
    garageName: input.garage.name,
    // A test opens the booking page itself: a working campaign link needs a real send.
    link: `${base.replace(/\/+$/, "")}/`,
  });
  if (!composed.ok) {
    await record("template", recipient.channel);
    return { ok: false, code: "template" };
  }

  const channel = (input.channelFor ?? ((kind: ChannelKind) => getChannel(kind, input.env ?? process.env)))(recipient.channel);
  let result;
  try {
    result = await channel.send({
      garageId: input.garage.id,
      to: recipient.to,
      body: `${TEST_PREFIX}${composed.body}`,
      ...(composed.subject ? { subject: `${TEST_PREFIX}${composed.subject}` } : {}),
      idempotencyKey: `campaign_test:${input.user.id}:${input.campaign.id}:${Date.now()}`,
    });
  } catch {
    result = { ok: false as const, code: "provider_error" as const, retryable: false };
  }
  if (!result.ok) {
    const code = result.code === "configuration_required" ? "configuration_required" : result.code === "rate_limited" ? "rate_limited" : "failed";
    await record(code, recipient.channel);
    return { ok: false, code };
  }
  await record("sent", recipient.channel);
  return { ok: true, channel: recipient.channel, to: recipient.channel === "email" ? maskEmail(recipient.to) : maskMobile(recipient.to), mode: channel.mode };
}
