"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { addDays, localDateKey } from "@/lib/admin/dates";
import { checkTemplate, defaultTemplate, parseOffsets, RULE_CHANNELS, RULE_KINDS, RULE_NAMES, type RuleChannel, type RuleKind } from "@/lib/reminders/rules";
import { replanReminders } from "@/lib/reminders/replan";
import { sendReminderTest } from "@/lib/reminders/test-send";
import type { SetupFormState } from "@/lib/settings/setup";
import { auditSetupChange, databaseProblem, NOT_ALLOWED_MESSAGES, requireSetupContext, roleAllows, stateFor } from "@/lib/settings/server";
import type { AdminContext } from "@/lib/tenancy/admin";

// Reminders page (P3.10): switch automations on and off, change their wording and timing, and send
// yourself a test. Owners and managers only, with MFA done in this session (requireSetupContext),
// through the member's RLS client (the reminder_rules policies allow the same two roles). The
// garage is always the member's selected garage; the form only names the kind of rule.

const PATH = "/app/reminders";

export type RuleField = "template" | "offsets" | "channel";

function kindFrom(value: FormDataEntryValue | null): RuleKind | null {
  return typeof value === "string" && (RULE_KINDS as readonly string[]).includes(value) ? (value as RuleKind) : null;
}

function channelFrom(value: FormDataEntryValue | null): RuleChannel | null {
  return typeof value === "string" && (RULE_CHANNELS as readonly string[]).includes(value) ? (value as RuleChannel) : null;
}

const DEFAULT_OFFSETS: Record<RuleKind, number[]> = { mot: [28, 7], service: [335], review: [1], missed_call: [0] };

/**
 * Updates the garage's rule of this kind, or adds it (with the default wording and timing) when the
 * garage has none yet. Returns false when nothing could be saved.
 */
async function writeRule(admin: AdminContext, kind: RuleKind, values: { enabled?: boolean; template?: string; offset_days?: number[]; channel?: RuleChannel }) {
  const { data, error } = await admin.client.from("reminder_rules").update(values).eq("garage_id", admin.garage.id).eq("kind", kind).select("id");
  if (error) return { ok: false as const, error };
  if ((data ?? []).length > 0) return { ok: true as const };
  const inserted = await admin.client.from("reminder_rules").insert({
    garage_id: admin.garage.id,
    kind,
    enabled: values.enabled ?? false,
    offset_days: values.offset_days ?? DEFAULT_OFFSETS[kind],
    channel: values.channel ?? "customer",
    template: values.template ?? defaultTemplate(kind),
  });
  return inserted.error ? { ok: false as const, error: inserted.error } : { ok: true as const };
}

/**
 * The automation switches. Switching review requests on needs a second, explicit confirmation
 * (`confirmed=yes`) after the consent note (A54); without it the page shows the note instead.
 */
export async function toggleRuleAction(formData: FormData) {
  const kind = kindFrom(formData.get("kind"));
  const enabled = formData.get("enabled") === "true";
  const admin = await requireSetupContext(PATH);
  if (!roleAllows(admin, "manage")) redirect(`${PATH}?error=not_allowed`);
  if (!kind) redirect(`${PATH}?error=not_found`);
  if (kind === "mot" && !admin.garage.motEnabled) redirect(`${PATH}?error=mot_off`);
  if (kind === "review" && enabled && formData.get("confirmed") !== "yes") redirect(`${PATH}?confirm=review#review-confirm`);

  const saved = await writeRule(admin, kind, { enabled });
  if (!saved.ok) redirect(`${PATH}?error=save_failed`);
  await auditSetupChange(admin, enabled ? "reminder_rule.enabled" : "reminder_rule.disabled", "reminder_rule", kind, { kind });
  if (kind !== "missed_call") await replanReminders(admin.garage.id);
  revalidatePath(PATH);
  revalidatePath("/app");
  redirect(`${PATH}?done=${kind}_${enabled ? "on" : "off"}`);
}

/** Saves a rule's wording, timing and channel (the editor's form, useActionState). */
export async function saveRuleAction(previous: SetupFormState<RuleField>, formData: FormData): Promise<SetupFormState<RuleField>> {
  const kind = kindFrom(formData.get("kind"));
  const admin = await requireSetupContext(kind ? `${PATH}?edit=${kind}` : PATH);
  if (!roleAllows(admin, "manage")) return stateFor(previous, { status: "error", message: NOT_ALLOWED_MESSAGES.manage });
  if (!kind) return stateFor(previous, { status: "error", message: "That automation could not be found. Reload the page and try again." });
  if (kind === "mot" && !admin.garage.motEnabled) {
    return stateFor(previous, { status: "error", message: "MOT reminders are off because the garage doesn't do MOTs. Switch MOTs on in Branding & MOT first." });
  }

  const template = String(formData.get("template") ?? "").replace(/\r\n?/g, "\n").trim();
  const fieldErrors: Partial<Record<RuleField, string>> = {};
  const check = checkTemplate(kind, template);
  if (!check.ok) fieldErrors.template = check.errors.join(" ");

  let offsets = DEFAULT_OFFSETS.missed_call;
  if (kind !== "missed_call") {
    const parsed = parseOffsets(String(formData.get("offsets") ?? ""));
    if (parsed.ok) offsets = parsed.value;
    else fieldErrors.offsets = parsed.error;
  }
  const channel = channelFrom(formData.get("channel"));
  if (!channel) fieldErrors.channel = "Choose how the message is sent.";
  if (Object.keys(fieldErrors).length > 0 || !channel) return stateFor(previous, { status: "error", message: "Check the highlighted fields.", fieldErrors });

  const saved = await writeRule(admin, kind, { template, offset_days: offsets, channel });
  if (!saved.ok) return stateFor(previous, { status: "error", message: databaseProblem(saved.error) });
  await auditSetupChange(admin, "reminder_rule.updated", "reminder_rule", kind, { kind, channel, offset_days: offsets, characters: template.length });
  if (kind !== "missed_call") await replanReminders(admin.garage.id);
  revalidatePath(PATH);
  return stateFor(previous, {
    status: "saved",
    message:
      kind === "missed_call"
        ? `${RULE_NAMES[kind]} saved. The next missed call gets this text.`
        : `${RULE_NAMES[kind]} saved. Reminders that haven't gone yet use the new wording and timing.`,
  });
}

const TEST_MESSAGES = {
  rate_limited: "That's 5 tests in 10 minutes. Try again in a few minutes.",
  no_address: "Your account has no mobile number or email address to send a test to.",
  template: "Fix the message first, then send a test.",
  configuration_required: "Texts and emails aren't set up for sending yet, so the test couldn't go.",
  failed: "The test couldn't be sent. Try again.",
} as const;

/** "Send me a test": the saved wording with sample details, to the member's own mobile or email. */
export async function sendTestAction(previous: SetupFormState, formData: FormData): Promise<SetupFormState> {
  const kind = kindFrom(formData.get("kind"));
  const admin = await requireSetupContext(PATH);
  if (!roleAllows(admin, "manage")) return stateFor(previous, { status: "error", message: NOT_ALLOWED_MESSAGES.manage });
  if (!kind || (kind === "mot" && !admin.garage.motEnabled)) return stateFor(previous, { status: "error", message: "That automation could not be found. Reload the page and try again." });

  const { data, error } = await admin.client.from("reminder_rules").select("kind,channel,template").eq("garage_id", admin.garage.id).eq("kind", kind).maybeSingle();
  if (error) return stateFor(previous, { status: "error", message: TEST_MESSAGES.failed });
  const rule = (data as { channel: string; template: string } | null) ?? { channel: "customer", template: defaultTemplate(kind) };

  const today = localDateKey(new Date(), admin.garage.timezone || "Europe/London");
  const result = await sendReminderTest({
    garage: { id: admin.garage.id, name: admin.garage.name, slug: admin.garage.slug, customDomain: admin.garage.customDomain },
    user: { id: admin.user.id, email: admin.user.email, phone: admin.user.phone },
    rule: { kind, channel: channelFrom(rule.channel) ?? "customer", template: rule.template },
    sampleDueDate: addDays(today, 28),
  });
  if (!result.ok) return stateFor(previous, { status: "error", message: TEST_MESSAGES[result.code] });
  const where = result.channel === "email" ? `your email (${result.to})` : `your mobile (${result.to})`;
  return stateFor(previous, {
    status: "saved",
    message:
      result.mode === "mock"
        ? `Test made for ${where}. Messaging is in test mode, so it went to the test outbox, not ${result.channel === "email" ? "your inbox" : "your phone"}.`
        : `Test sent to ${where}.`,
  });
}
