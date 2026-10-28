"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { localDateKey, zonedInstant } from "@/lib/admin/dates";
import { loadCampaign, previewAudience, type AudiencePreview } from "@/lib/campaigns/admin";
import { segmentFromForm, type SegmentField } from "@/lib/campaigns/segment";
import { sendCampaignTest } from "@/lib/campaigns/test-send";
import {
  CAMPAIGN_EMAIL_TEMPLATE_MAX,
  CAMPAIGN_NAME_MAX,
  CAMPAIGN_SUBJECT_MAX,
  checkCampaignTemplate,
  isCampaignStarter,
} from "@/lib/campaigns/templates";
import { featureProblem } from "@/lib/plans/server";
import type { SetupFormState } from "@/lib/settings/setup";
import { auditSetupChange, databaseProblem, NOT_ALLOWED_MESSAGES, requireSetupContext, roleAllows, stateFor } from "@/lib/settings/server";

// Campaigns (P5.5, Pro feature `campaigns`). Owners and managers only, with MFA done in this session
// (requireSetupContext), through the member's RLS client for the selected garage: the campaigns
// write policies allow the same two roles on a plan with campaigns, and drafts only. Scheduling and
// cancelling go through schedule_campaign() / cancel_campaign(), which check the role, the plan and
// the garage again in SQL. The garage is never taken from the form; ids in the form are looked up
// within the selected garage.

const PATH = "/app/campaigns";
const FEATURE = "campaigns" as const;
const uuid = z.string().uuid();

export type CampaignField = "name" | "template" | "emailSubject" | "emailTemplate" | "serviceId" | SegmentField;

const baseSchema = z.object({
  name: z.string().trim().min(1, "Give the campaign a name.").max(CAMPAIGN_NAME_MAX, `Keep the name under ${CAMPAIGN_NAME_MAX} characters.`),
  emailSubject: z.string().trim().min(1, "Write the email subject.").max(CAMPAIGN_SUBJECT_MAX, `Keep the subject under ${CAMPAIGN_SUBJECT_MAX} characters.`),
  serviceId: z.union([z.literal(""), uuid]),
});

function text(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
}

/** Creates or updates a draft (the editor's form, useActionState). A new draft opens on its own page. */
export async function saveCampaignAction(previous: SetupFormState<CampaignField>, formData: FormData): Promise<SetupFormState<CampaignField>> {
  const id = text(formData, "id");
  const admin = await requireSetupContext(id ? `${PATH}/${id}` : `${PATH}/new`);
  if (!roleAllows(admin, "manage")) return stateFor(previous, { status: "error", message: NOT_ALLOWED_MESSAGES.manage });
  const planProblem = featureProblem(admin, FEATURE);
  if (planProblem) return stateFor(previous, { status: "error", message: planProblem });

  const fieldErrors: Partial<Record<CampaignField, string>> = {};
  const base = baseSchema.safeParse({ name: text(formData, "name"), emailSubject: text(formData, "emailSubject"), serviceId: text(formData, "serviceId") });
  if (!base.success) {
    for (const issue of base.error.issues) {
      const field = issue.path[0] as CampaignField;
      fieldErrors[field] ??= field === "serviceId" ? "Choose a service from the list." : issue.message;
    }
  }
  const template = text(formData, "template");
  const check = checkCampaignTemplate(template);
  if (!check.ok) fieldErrors.template = check.errors.join(" ");
  const emailTemplate = text(formData, "emailTemplate");
  if (emailTemplate) {
    const emailCheck = checkCampaignTemplate(emailTemplate, { max: CAMPAIGN_EMAIL_TEMPLATE_MAX });
    if (!emailCheck.ok) fieldErrors.emailTemplate = emailCheck.errors.join(" ");
  }
  const segment = segmentFromForm(formData, { motEnabled: admin.garage.motEnabled });
  if (!segment.ok) Object.assign(fieldErrors, segment.fieldErrors);
  if (Object.keys(fieldErrors).length > 0 || !base.success || !segment.ok) {
    return stateFor(previous, { status: "error", message: "Check the highlighted fields.", fieldErrors });
  }

  const starter = text(formData, "starter");
  const values = {
    name: base.data.name,
    segment: segment.segment,
    template,
    email_subject: base.data.emailSubject,
    email_template: emailTemplate || null,
    service_id: base.data.serviceId || null,
  };

  if (id) {
    if (!uuid.safeParse(id).success) return stateFor(previous, { status: "error", message: "That campaign could not be found. Reload the page and try again." });
    const { data, error } = await admin.client.from("campaigns").update(values).eq("garage_id", admin.garage.id).eq("id", id).eq("status", "draft").select("id");
    if (error) return stateFor(previous, { status: "error", message: databaseProblem(error) });
    if ((data ?? []).length === 0) return stateFor(previous, { status: "error", message: "Only drafts can be changed. This campaign has been scheduled already." });
    await auditSetupChange(admin, "campaign.updated", "campaign", id, { characters: template.length });
    revalidatePath(`${PATH}/${id}`);
    revalidatePath(PATH);
    return stateFor(previous, { status: "saved", message: "Draft saved." });
  }

  const { data, error } = await admin.client
    .from("campaigns")
    .insert({ garage_id: admin.garage.id, ...values, starter: isCampaignStarter(starter) ? starter : null })
    .select("id")
    .single();
  if (error || !data) return stateFor(previous, { status: "error", message: databaseProblem(error) });
  const created = (data as { id: string }).id;
  await auditSetupChange(admin, "campaign.created", "campaign", created, { starter: isCampaignStarter(starter) ? starter : null });
  revalidatePath(PATH);
  redirect(`${PATH}/${created}?done=saved`);
}

export type PreviewState = { seq: number; status: "idle" | "ready" | "error"; preview?: AudiencePreview; message?: string };

const PREVIEW_MESSAGES = {
  plan_required: "Campaigns are part of Pro.",
  mot_disabled: "MOT months need MOTs switched on in Branding & MOT.",
  not_allowed: "Only the garage's owners and managers can build campaigns.",
  failed: "The count could not be worked out. Try again.",
} as const;

/** The live count and preview for the segment builder's current fields (nothing is saved). */
export async function previewAudienceAction(previous: PreviewState, formData: FormData): Promise<PreviewState> {
  const admin = await requireSetupContext(PATH);
  const seq = previous.seq + 1;
  if (!roleAllows(admin, "manage")) return { seq, status: "error", message: PREVIEW_MESSAGES.not_allowed };
  const planProblem = featureProblem(admin, FEATURE);
  if (planProblem) return { seq, status: "error", message: planProblem };
  const segment = segmentFromForm(formData, { motEnabled: admin.garage.motEnabled });
  if (!segment.ok) return { seq, status: "error", message: Object.values(segment.fieldErrors)[0] ?? "Check the filters." };
  const result = await previewAudience(admin.client, segment.segment, 8);
  if (!result.ok) return { seq, status: "error", message: PREVIEW_MESSAGES[result.error] };
  return { seq, status: "ready", preview: result.preview };
}

/** Sends due campaign messages straight after the response (the cron also does; this saves the wait). */
function drainCampaignsAfterResponse() {
  try {
    after(async () => {
      try {
        const { drainJobs } = await import("@/lib/jobs/runner");
        await drainJobs({ kinds: ["campaigns.send"], budgetMs: 8_000 });
      } catch {
        // The queued job stays for the next drain.
      }
    });
  } catch {
    // Outside a request: nothing to wait for.
  }
}

/** Schedules a draft: now, or at a date and time in the garage's time zone (Europe/London). */
export async function scheduleCampaignAction(formData: FormData) {
  const id = text(formData, "id");
  const back = uuid.safeParse(id).success ? `${PATH}/${id}` : PATH;
  const admin = await requireSetupContext(back);
  if (!roleAllows(admin, "manage")) redirect(`${back}?error=not_allowed`);
  if (featureProblem(admin, FEATURE)) redirect(`${back}?error=plan_required`);
  if (back === PATH) redirect(`${PATH}?error=not_found`);

  const campaign = await loadCampaign(admin.client, admin.garage.id, id);
  if (!campaign) redirect(`${PATH}?error=not_found`);
  if (campaign.status !== "draft") redirect(`${back}?error=not_draft`);
  if (!checkCampaignTemplate(campaign.template).ok) redirect(`${back}?error=template`);

  const timeZone = admin.garage.timezone || "Europe/London";
  let sendAt: Date | null = null;
  if (text(formData, "when") === "later") {
    sendAt = zonedInstant(text(formData, "sendAt"), timeZone);
    if (!sendAt) redirect(`${back}?error=bad_time`);
    if (sendAt.getTime() < Date.now() - 60_000) redirect(`${back}?error=past_time`);
    if (localDateKey(sendAt, timeZone) > localDateKey(new Date(Date.now() + 365 * 86_400_000), timeZone)) redirect(`${back}?error=bad_time`);
  }

  const { error } = await admin.client.rpc("schedule_campaign", { p_campaign_id: campaign.id, p_send_at: sendAt?.toISOString() ?? null });
  if (error) {
    const message = error.message ?? "";
    const code = message.startsWith("EMPTY_AUDIENCE")
      ? "empty"
      : message.startsWith("PLAN_REQUIRED")
        ? "plan_required"
        : message.startsWith("MOT_DISABLED")
          ? "mot_off"
          : message.startsWith("INVALID_SEND_AT")
            ? "bad_time"
            : error.code === "42501"
              ? "not_allowed"
              : "save_failed";
    redirect(`${back}?error=${code}`);
  }
  if (!sendAt) drainCampaignsAfterResponse();
  revalidatePath(PATH);
  revalidatePath(back);
  redirect(`${back}?done=${sendAt ? "scheduled" : "sending"}`);
}

/** Stops a scheduled campaign; messages already sent stay sent. Allowed on any plan. */
export async function cancelCampaignAction(formData: FormData) {
  const id = text(formData, "id");
  const back = uuid.safeParse(id).success ? `${PATH}/${id}` : PATH;
  const admin = await requireSetupContext(back);
  if (!roleAllows(admin, "manage")) redirect(`${back}?error=not_allowed`);
  if (back === PATH) redirect(`${PATH}?error=not_found`);
  const { error } = await admin.client.rpc("cancel_campaign", { p_campaign_id: id });
  if (error) redirect(`${back}?error=${error.code === "42501" ? "not_allowed" : "cancel_failed"}`);
  revalidatePath(PATH);
  revalidatePath(back);
  redirect(`${back}?done=cancelled`);
}

/** Deletes a draft (scheduled and sent campaigns are kept for their results). */
export async function deleteCampaignAction(formData: FormData) {
  const id = text(formData, "id");
  const admin = await requireSetupContext(PATH);
  if (!roleAllows(admin, "manage")) redirect(`${PATH}?error=not_allowed`);
  if (featureProblem(admin, FEATURE)) redirect(`${PATH}?error=plan_required`);
  if (!uuid.safeParse(id).success) redirect(`${PATH}?error=not_found`);
  const { data, error } = await admin.client.from("campaigns").delete().eq("garage_id", admin.garage.id).eq("id", id).eq("status", "draft").select("id");
  if (error || (data ?? []).length === 0) redirect(`${PATH}/${id}?error=delete_failed`);
  await auditSetupChange(admin, "campaign.deleted", "campaign", id);
  revalidatePath(PATH);
  redirect(`${PATH}?done=deleted`);
}

const TEST_MESSAGES = {
  rate_limited: "That's 5 tests in 10 minutes. Try again in a few minutes.",
  no_address: "Your account has no mobile number or email address to send a test to.",
  template: "Fix the message first, then send a test.",
  configuration_required: "Texts and emails aren't set up for sending yet, so the test couldn't go.",
  failed: "The test couldn't be sent. Try again.",
} as const;

/** "Send me a test": the saved wording with sample details, to the member's own mobile or email. */
export async function sendCampaignTestAction(previous: SetupFormState, formData: FormData): Promise<SetupFormState> {
  const id = text(formData, "id");
  const admin = await requireSetupContext(PATH);
  if (!roleAllows(admin, "manage")) return stateFor(previous, { status: "error", message: NOT_ALLOWED_MESSAGES.manage });
  const planProblem = featureProblem(admin, FEATURE);
  if (planProblem) return stateFor(previous, { status: "error", message: planProblem });
  const campaign = uuid.safeParse(id).success ? await loadCampaign(admin.client, admin.garage.id, id) : null;
  if (!campaign) return stateFor(previous, { status: "error", message: "That campaign could not be found. Reload the page and try again." });

  const result = await sendCampaignTest({
    garage: { id: admin.garage.id, name: admin.garage.name, slug: admin.garage.slug, customDomain: admin.garage.customDomain },
    user: { id: admin.user.id, email: admin.user.email, phone: admin.user.phone },
    campaign: { id: campaign.id, template: campaign.template, emailSubject: campaign.emailSubject, emailTemplate: campaign.emailTemplate },
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
