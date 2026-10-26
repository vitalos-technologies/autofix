"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { retryEnquiryNotifications } from "@/lib/enquiries/repository";
import { addInternalNote, ignoreUnmatchedInboundEmail, linkUnmatchedInboundEmail, markEnquiryThreadRead, sendEnquiryReply, type ReplyState } from "@/lib/enquiries/thread-repository";
import { createAdminClient, getAdminUser } from "@/lib/supabase/server";
import { formatOpeningHours } from "@/lib/settings/opening-hours";
import { safeAdminReturnTo } from "@/lib/auth/mfa";

async function requireAdmin() {
  const auth = await getAdminUser({ requireMfa: false });
  if (auth?.mfaState === "enrollment_required") redirect("/app/mfa/enroll");
  if (auth?.mfaRequired && !auth.mfaVerified) {
    const referer = (await headers()).get("referer");
    let returnTo = "/app";
    try {
      const url = referer ? new URL(referer) : null;
      returnTo = safeAdminReturnTo(url ? `${url.pathname}${url.search}` : null);
    } catch {
      returnTo = "/app";
    }
    redirect(`/app/mfa?returnTo=${encodeURIComponent(returnTo)}&stepUp=1`);
  }
  const client = createAdminClient();
  if (!auth || !client) throw new Error("Unauthorised");
  return { auth, client };
}

async function audit(client: NonNullable<ReturnType<typeof createAdminClient>>, actorId: string, action: string, entityType: string, entityId: string, detail: Record<string, unknown> = {}) {
  const { error } = await client.from("admin_audit_log").insert({ actor_id: actorId, action, entity_type: entityType, entity_id: entityId, detail });
  if (error) throw new Error("The change was saved, but its required audit entry could not be recorded.");
}

export async function updateEnquiryStatus(formData: FormData) {
  const { auth, client } = await requireAdmin();
  const id = z.string().uuid().parse(formData.get("id")); const status = z.enum(["new", "contacted", "booked", "closed"]).parse(formData.get("status"));
  await client.from("enquiries").update({ status, closed_at: status === "closed" ? new Date().toISOString() : null }).eq("id", id);
  await audit(client, auth.user.id, "status_change", "enquiry", id, { status });
  revalidatePath("/app/enquiries");
  revalidatePath(`/app/enquiries/${id}`);
  revalidatePath("/app/notifications");
  revalidatePath("/app", "layout");
}

export async function sendEnquiryReplyAction(previous: ReplyState, formData: FormData): Promise<ReplyState> {
  const { auth } = await requireAdmin();
  const enquiryId = String(formData.get("enquiryId") || "");
  const draft = String(formData.get("body") || "");
  const clientRequestId = String(formData.get("clientRequestId") || previous.clientRequestId || "");
  try {
    await sendEnquiryReply({ enquiryId, body: draft, clientRequestId, actorId: auth.user.id, actorName: auth.profile.display_name });
    revalidateEnquiryThread(enquiryId);
    return { status: "sent", message: "Reply sent to the customer.", draft: "", clientRequestId: crypto.randomUUID() };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "The reply could not be sent.", draft, clientRequestId };
  }
}

export async function saveInternalNoteAction(previous: ReplyState, formData: FormData): Promise<ReplyState> {
  const { auth } = await requireAdmin();
  const enquiryId = String(formData.get("enquiryId") || "");
  const draft = String(formData.get("body") || "");
  try {
    await addInternalNote({ enquiryId, body: draft, actorId: auth.user.id, actorName: auth.profile.display_name });
    revalidateEnquiryThread(enquiryId);
    return { status: "sent", message: "Internal note saved. It was not emailed.", draft: "", clientRequestId: crypto.randomUUID() };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "The note could not be saved.", draft, clientRequestId: previous.clientRequestId };
  }
}

export async function markEnquiryThreadReadAction(enquiryId: string) {
  await requireAdmin();
  await markEnquiryThreadRead(enquiryId);
  revalidateEnquiryThread(enquiryId);
}

export async function linkUnmatchedInboundAction(formData: FormData) {
  const { auth } = await requireAdmin();
  const enquiryId = await linkUnmatchedInboundEmail({
    unmatchedId: String(formData.get("unmatchedId") || ""),
    enquiryId: String(formData.get("enquiryId") || ""),
    actorId: auth.user.id,
  });
  revalidateEnquiryThread(enquiryId);
  revalidatePath("/app/enquiries/unmatched");
  redirect(`/app/enquiries/${enquiryId}`);
}

export async function ignoreUnmatchedInboundAction(formData: FormData) {
  const { auth } = await requireAdmin();
  await ignoreUnmatchedInboundEmail({ unmatchedId: String(formData.get("unmatchedId") || ""), actorId: auth.user.id });
  revalidatePath("/app/enquiries/unmatched");
  revalidatePath("/app/enquiries");
  revalidatePath("/app/notifications");
  revalidatePath("/app", "layout");
}

function revalidateEnquiryThread(enquiryId: string) {
  revalidatePath(`/app/enquiries/${enquiryId}`);
  revalidatePath("/app/enquiries");
  revalidatePath("/app/notifications");
  revalidatePath("/app", "layout");
}

export async function resendEnquiryNotifications(formData: FormData) {
  const { auth, client } = await requireAdmin();
  const id = z.string().uuid().parse(formData.get("id"));
  const status = await retryEnquiryNotifications(id);
  await audit(client, auth.user.id, "notification_retry", "enquiry", id, { status });
  revalidatePath("/app/enquiries");
  revalidatePath("/app/notifications");
}

export async function saveSettings(formData: FormData) {
  const { auth, client } = await requireAdmin();
  const openingHours = Object.fromEntries(
    ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "bankHolidays"]
      .map((day) => [day, formatOpeningHours(formData.get(`${day}Open`), formData.get(`${day}Close`))] as const)
      .filter(([, hours]) => hours.length > 0),
  );
  const value = {
    name: String(formData.get("name")),
    legalName: String(formData.get("legalName")),
    companyNumber: String(formData.get("companyNumber")),
    phone: String(formData.get("phone")),
    whatsapp: String(formData.get("whatsapp")),
    email: String(formData.get("email")),
    address: {
      building: String(formData.get("building")),
      street: String(formData.get("street")),
      town: String(formData.get("town")),
      city: String(formData.get("city")),
      postcode: String(formData.get("postcode")),
      country: "United Kingdom",
      countryCode: "GB",
    },
    openingHours,
    googleMapsUrl: String(formData.get("googleMapsUrl") || ""),
  };
  await client.from("site_settings").upsert({ id: true, value, updated_by: auth.user.id });
  await audit(client, auth.user.id, "update", "site_settings", "primary");
  revalidatePath("/", "layout");
  redirect("/app/settings");
}
