"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { parseAskbridgeWidgetId } from "@/lib/askbridge/config";
import { parseEmbedOrigins } from "@/lib/booking-page/embed-origins";
import { checkCustomDomainNow, connectCustomDomain, removeCustomDomain, retryCustomDomain, type CheckNowResult } from "@/lib/booking-page/domains-server";
import { auditSetupChange, NOT_ALLOWED_MESSAGES, requireSetupContext, roleAllows, stateFor } from "@/lib/settings/server";
import type { SetupFormState } from "@/lib/settings/setup";
import { createAdminClient } from "@/lib/supabase/server";
import type { AdminContext } from "@/lib/tenancy/admin";
import { clearHostCache } from "@/lib/tenancy/resolve";

// Booking page & domain (P4.3) and Askbridge (P4.6). Owners only (A59: the garage's own settings);
// everyone else reads. The garage is always the signed-in member's selected garage.

const PATH = "/app/settings/booking-page";

function afterBookingPageChange(admin: Pick<AdminContext, "garage">, hostnames: string[] = []) {
  clearHostCache({ slugs: [admin.garage.slug], hostnames: [...hostnames, ...(admin.garage.customDomain ? [admin.garage.customDomain] : [])] });
  revalidatePath(PATH);
  revalidatePath("/_site/[garageId]", "layout");
}

const SERVICE_UNAVAILABLE = "We couldn't reach the database just now. Try again in a minute.";

export async function connectDomainAction(previous: SetupFormState<"hostname">, formData: FormData): Promise<SetupFormState<"hostname">> {
  const admin = await requireSetupContext(PATH);
  if (!roleAllows(admin, "owner")) return stateFor(previous, { status: "error", message: NOT_ALLOWED_MESSAGES.owner });
  const service = createAdminClient();
  if (!service) return stateFor(previous, { status: "error", message: SERVICE_UNAVAILABLE });

  const result = await connectCustomDomain(admin.garage.id, String(formData.get("hostname") ?? ""), { rls: admin.client, service });
  if (!result.ok) {
    const fieldErrors = result.code === "invalid" || result.code === "taken" ? { hostname: result.message } : undefined;
    return stateFor(previous, { status: "error", message: result.message, fieldErrors });
  }
  await auditSetupChange(admin, "booking_page.domain_connected", "garage_domain", result.domain.id, { hostname: result.domain.hostname, queued: result.queued });
  afterBookingPageChange(admin, [result.domain.hostname]);
  return stateFor(previous, {
    status: "saved",
    message: `${result.domain.hostname} added. Now add the record below at your domain provider; we check for it every few minutes.`,
  });
}

function checkMessage(result: CheckNowResult): Omit<SetupFormState, "seq"> {
  if (!result.ok) return { status: "error", message: result.message };
  const { domain } = result;
  if (domain.status === "active") return { status: "saved", message: `${domain.hostname} is live. Customers can book there now.` };
  if (domain.status === "verifying") return { status: "saved", message: "We found your record. Securing the address (HTTPS) usually takes a few minutes." };
  if (domain.status === "failed") return { status: "error", message: domain.error ?? "We couldn't connect your address." };
  return { status: "saved", message: "We haven't found the record yet. DNS changes can take up to an hour; we keep checking on our own." };
}

export async function checkDomainAction(previous: SetupFormState, formData: FormData): Promise<SetupFormState> {
  const retry = formData.get("intent") === "retry";
  const admin = await requireSetupContext(PATH);
  if (!roleAllows(admin, "owner")) return stateFor(previous, { status: "error", message: NOT_ALLOWED_MESSAGES.owner });
  const service = createAdminClient();
  if (!service) return stateFor(previous, { status: "error", message: SERVICE_UNAVAILABLE });

  const result = retry ? await retryCustomDomain(admin.garage.id, { service }) : await checkCustomDomainNow(admin.garage.id, { service });
  if (result.ok && (result.changed || retry)) {
    await auditSetupChange(admin, retry ? "booking_page.domain_retried" : "booking_page.domain_checked", "garage_domain", result.domain.id, { hostname: result.domain.hostname, status: result.domain.status });
  }
  if (result.ok) afterBookingPageChange(admin, [result.domain.hostname]);
  return stateFor(previous, checkMessage(result));
}

export async function removeDomainAction() {
  const admin = await requireSetupContext(PATH);
  if (!roleAllows(admin, "owner")) redirect(`${PATH}?error=not_allowed`);
  const service = createAdminClient();
  if (!service) redirect(`${PATH}?error=save_failed`);
  const result = await removeCustomDomain(admin.garage.id, { rls: admin.client, service });
  if (!result.ok) redirect(`${PATH}?error=${result.code === "none" ? "no_domain" : "save_failed"}`);
  await auditSetupChange(admin, "booking_page.domain_removed", "garage_domain", admin.garage.id, { hostname: result.hostname, detached: result.detached });
  afterBookingPageChange(admin, [result.hostname]);
  redirect(`${PATH}?done=domain_removed#own-address`);
}

type SettingsRpcError = { code?: string | null } | null;

function settingsProblem(error: SettingsRpcError) {
  if (error?.code === "42501") return NOT_ALLOWED_MESSAGES.owner;
  if (error?.code === "22023") return "Some of the values can't be saved. Check them and try again.";
  return "That could not be saved. Try again.";
}

export async function saveEmbedOriginsAction(previous: SetupFormState<"origins">, formData: FormData): Promise<SetupFormState<"origins">> {
  const admin = await requireSetupContext(PATH);
  if (!roleAllows(admin, "owner")) return stateFor(previous, { status: "error", message: NOT_ALLOWED_MESSAGES.owner });
  const parsed = parseEmbedOrigins(String(formData.get("origins") ?? ""));
  if (!parsed.ok) return stateFor(previous, { status: "error", message: parsed.message, fieldErrors: { origins: parsed.message } });

  const { error } = await admin.client.rpc("set_booking_page_settings", { p_embed_origins: parsed.origins, p_askbridge: null });
  if (error) return stateFor(previous, { status: "error", message: settingsProblem(error) });
  await auditSetupChange(admin, "booking_page.embed_origins_updated", "garage", admin.garage.id, { origins: parsed.origins });
  afterBookingPageChange(admin);
  return stateFor(previous, {
    status: "saved",
    message: parsed.origins.length
      ? `Saved. ${parsed.origins.length === 1 ? "That website" : `Those ${parsed.origins.length} websites`} can now show your booking page.`
      : "Saved. No other website can show your booking page inside its own page.",
  });
}

export async function saveAskbridgeAction(previous: SetupFormState<"widgetId">, formData: FormData): Promise<SetupFormState<"widgetId">> {
  const admin = await requireSetupContext(PATH);
  if (!roleAllows(admin, "owner")) return stateFor(previous, { status: "error", message: NOT_ALLOWED_MESSAGES.owner });
  const enabled = formData.get("enabled") === "on";
  const rawId = String(formData.get("widgetId") ?? "").trim();
  const widgetId = rawId ? parseAskbridgeWidgetId(rawId) : null;
  if (rawId && !widgetId) {
    const message = "Enter the widget ID exactly as Askbridge shows it (letters, numbers, _ and -).";
    return stateFor(previous, { status: "error", message, fieldErrors: { widgetId: message } });
  }
  if (enabled && !widgetId) {
    const message = "Enter your Askbridge widget ID to turn the chat on.";
    return stateFor(previous, { status: "error", message, fieldErrors: { widgetId: message } });
  }

  const { error } = await admin.client.rpc("set_booking_page_settings", { p_embed_origins: null, p_askbridge: { enabled, widgetId } });
  if (error) return stateFor(previous, { status: "error", message: settingsProblem(error) });
  await auditSetupChange(admin, enabled ? "askbridge.enabled" : "askbridge.disabled", "garage", admin.garage.id, { widgetId });
  afterBookingPageChange(admin);
  return stateFor(previous, {
    status: "saved",
    message: enabled ? "Saved. The Askbridge chat shows on your booking page, and we send it your services and opening hours." : "Saved. The Askbridge chat is off.",
  });
}
