import "server-only";

import { recordAdminAudit } from "@/lib/admin/audit";
import { maskEmail, maskMobile } from "@/lib/booking-flow/copy";
import { isValidEmailAddress } from "@/lib/email/identity";
import { getChannel, type ChannelKind, type MessageChannel } from "@/lib/messaging/channel";
import { toE164UK } from "@/lib/messaging/phone";
import { DEFAULT_TEMPLATES, renderTemplate } from "@/lib/messaging/templates";
import { consumeRateLimit } from "@/lib/rate-limit";
import { garageBaseUrl, type GarageUrlSubject, type UrlEnvironment } from "@/lib/tenancy/urls";
import { formatReminderDate } from "./compose";
import { checkTemplate, sampleTemplateValues, type RuleChannel, type RuleKind } from "./rules";

// "Send me a test" on the Reminders page (P3.10). The rule's saved wording, filled in with the same
// sample details as the preview, goes to the signed-in member's own mobile (from their account) or,
// failing that, their own email: never to a customer and never to an address typed into the form.
// Mock outbox unless MESSAGING_MODE=live (getChannel). At most 5 tests per member per 10 minutes.
// Every attempt is audited as `reminder.test_sent` with the kind, channel and outcome only (no
// address, no text). A test is not a reminder: it is not stored in `messages` or `reminder_sends`
// and the send window does not apply (the member asked for it, to themselves).

export const TEST_RATE_LIMIT = { limit: 5, windowSeconds: 600 } as const;
export const TEST_PREFIX = "Test: ";

export type TestSendInput = {
  garage: GarageUrlSubject & { id: string; name: string };
  user: { id: string; email?: string | null; phone?: string | null };
  rule: { kind: RuleKind; channel: RuleChannel; template: string };
  /** The date the sample reminder is about (YYYY-MM-DD); the preview uses the same one. */
  sampleDueDate: string;
  channelFor?: (kind: ChannelKind) => MessageChannel;
  rateLimit?: (identifier: string, scope: string, limit: number, windowSeconds: number) => Promise<boolean>;
  audit?: typeof recordAdminAudit;
  env?: UrlEnvironment & Record<string, string | undefined>;
};

export type TestSendResult =
  | { ok: true; channel: ChannelKind; to: string; mode: "mock" | "live" }
  | { ok: false; code: "rate_limited" | "no_address" | "template" | "configuration_required" | "failed"; errors?: string[] };

/**
 * Where the test goes: the member's own mobile (their sign-in account's number) for texts and
 * WhatsApp, else their own sign-in email. The missed-call text-back is only ever a text, so its test
 * needs a mobile.
 */
export function testRecipient(user: TestSendInput["user"], rule: Pick<TestSendInput["rule"], "kind" | "channel">): { channel: ChannelKind; to: string } | null {
  const phone = toE164UK(user.phone ?? null);
  const email = user.email && isValidEmailAddress(user.email) ? user.email : null;
  if (rule.kind === "missed_call") return phone ? { channel: rule.channel === "whatsapp" ? "whatsapp" : "sms", to: phone } : null;
  if (rule.channel !== "email" && phone) return { channel: rule.channel === "whatsapp" ? "whatsapp" : "sms", to: phone };
  if (email) return { channel: "email", to: email };
  return null;
}

/** The test as the member will get it: the sample details, the opt-out line and "Test: " in front. */
export function composeTest(input: Pick<TestSendInput, "garage" | "rule" | "sampleDueDate" | "env">, channel: ChannelKind) {
  const base = garageBaseUrl(input.garage, input.env);
  const values = sampleTemplateValues({ kind: input.rule.kind, garageName: input.garage.name, bookingBaseUrl: base, dueDate: formatReminderDate(input.sampleDueDate) });
  // The link in a test opens the booking page itself: a working reminder link needs a real reminder.
  const vars = { ...values, link: `${base.replace(/\/+$/, "")}/` };
  const rendered = renderTemplate(input.rule.template, vars, { channel });
  const subject = channel === "email" ? `${TEST_PREFIX}${renderTemplate(DEFAULT_TEMPLATES[input.rule.kind].subject, vars).text}` : undefined;
  return { body: `${TEST_PREFIX}${rendered.text}`, subject, unknown: rendered.unknownPlaceholders, missing: rendered.missingPlaceholders };
}

function display(channel: ChannelKind, to: string) {
  return channel === "email" ? maskEmail(to) : maskMobile(to);
}

export async function sendReminderTest(input: TestSendInput): Promise<TestSendResult> {
  const audit = input.audit ?? recordAdminAudit;
  const record = async (outcome: string, channel?: ChannelKind) => {
    try {
      await audit(input.garage.id, {
        actorId: input.user.id,
        action: "reminder.test_sent",
        entityType: "reminder_rule",
        entityId: input.rule.kind,
        detail: { kind: input.rule.kind, outcome, ...(channel ? { channel } : {}) },
      });
    } catch {
      // The audit log is a record, not a gate, for a test to the member themselves.
    }
  };

  const allowed = await (input.rateLimit ?? consumeRateLimit)(input.user.id, "reminder_test", TEST_RATE_LIMIT.limit, TEST_RATE_LIMIT.windowSeconds);
  if (!allowed) {
    await record("rate_limited");
    return { ok: false, code: "rate_limited" };
  }

  const check = checkTemplate(input.rule.kind, input.rule.template);
  if (!check.ok) {
    await record("template");
    return { ok: false, code: "template", errors: check.errors };
  }

  const recipient = testRecipient(input.user, input.rule);
  if (!recipient) {
    await record("no_address");
    return { ok: false, code: "no_address" };
  }

  const composed = composeTest(input, recipient.channel);
  if (composed.unknown.length > 0 || composed.missing.length > 0) {
    await record("template", recipient.channel);
    return { ok: false, code: "template" };
  }

  const channel = (input.channelFor ?? ((kind: ChannelKind) => getChannel(kind, input.env ?? process.env)))(recipient.channel);
  let result;
  try {
    result = await channel.send({
      garageId: input.garage.id,
      to: recipient.to,
      body: composed.body,
      ...(composed.subject ? { subject: composed.subject } : {}),
      idempotencyKey: `reminder_test:${input.user.id}:${input.rule.kind}:${Date.now()}`,
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
  return { ok: true, channel: recipient.channel, to: display(recipient.channel, recipient.to), mode: channel.mode };
}
