"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireStaffWriter } from "@/lib/admin/staff";
import { markMissedCallHandled } from "@/lib/calls/actions";
import { markThreadRead } from "@/lib/messages/inbox";
import { canReply, REPLY_MAX_LENGTH, sendStaffReply } from "@/lib/messages/reply";
import { getAdminContext } from "@/lib/tenancy/admin";

// Messages & calls (`/app/messages`). The garage is the member's selected garage and the member
// the signed-in user; the forms only name the customer (or call) by id.

const customerIdSchema = z.string().uuid();

export type ReplyState = { seq: number; status: "idle" | "sent" | "error"; message?: string; fieldError?: string };

const REPLY_MESSAGES: Record<string, string> = {
  empty: "Write a message first.",
  too_long: `Keep it under ${REPLY_MAX_LENGTH} characters.`,
  rate_limited: "That's a lot of replies in a few minutes. Wait a moment and try again.",
  unavailable: "The reply couldn't be sent. Try again.",
  failed: "The reply didn't go: the provider turned it down. It's marked Not delivered in the conversation.",
  not_allowed: "Only owners, managers and front desk can reply.",
  not_found: "That customer could not be found. Reload the page.",
  anonymised: "This customer's details were removed, so they can't be messaged.",
  opted_out: "This customer has opted out, so they can't be texted.",
  no_address: "There's no mobile number or email for this customer on their channel.",
  no_messaging_number: "Your garage doesn't have a texting number yet. Ask Vitalos to set one up.",
};

/** Sends a reply on the customer's channel (owners, managers, front desk; MFA done this session). */
export async function replyAction(previous: ReplyState, formData: FormData): Promise<ReplyState> {
  const customerId = customerIdSchema.safeParse(formData.get("customerId"));
  const path = customerId.success ? `/app/messages/${customerId.data}` : "/app/messages";
  const admin = await requireStaffWriter(path);
  const next = (state: Omit<ReplyState, "seq">): ReplyState => ({ seq: previous.seq + 1, ...state });
  if (!canReply(admin.role)) return next({ status: "error", message: REPLY_MESSAGES.not_allowed });
  if (!customerId.success) return next({ status: "error", message: REPLY_MESSAGES.not_found });
  const body = typeof formData.get("body") === "string" ? String(formData.get("body")) : "";

  const result = await sendStaffReply({ garage: { id: admin.garage.id, name: admin.garage.name }, member: { id: admin.user.id }, customerId: customerId.data, body });
  if (!result.ok) {
    if (result.messageId) revalidatePath(path);
    const message = REPLY_MESSAGES[result.code] ?? REPLY_MESSAGES.unavailable;
    return next({ status: "error", message, ...(result.code === "empty" || result.code === "too_long" ? { fieldError: message } : {}) });
  }
  // They've seen what they answered.
  await markThreadRead(admin.client, admin.garage.id, customerId.data, admin.user.id);
  revalidatePath(path);
  revalidatePath("/app/messages");
  return next({
    status: "sent",
    message: result.mode === "mock" ? "Reply made. Messaging is in test mode, so it went to the test outbox, not to the customer." : "Reply sent.",
  });
}

/**
 * Marks the customer's unread messages read when a member opens the conversation (any member, as
 * themselves; a remembered device is enough, as for reading). Called from the thread page once it
 * is on screen, so a prefetch never marks anything read.
 */
export async function markThreadReadAction(customerId: string): Promise<{ ok: boolean; marked: number }> {
  const id = customerIdSchema.safeParse(customerId);
  if (!id.success) return { ok: false, marked: 0 };
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) return { ok: false, marked: 0 };
  const marked = await markThreadRead(admin.client, admin.garage.id, id.data, admin.user.id);
  if (marked > 0) revalidatePath("/app/messages");
  return { ok: true, marked };
}

/** "Mark handled" on the Calls tab: the P4.1 action, then this page shows the change. */
export async function markCallHandledAction(formData: FormData): Promise<void> {
  await markMissedCallHandled(formData.get("callId"));
  revalidatePath("/app/messages/calls");
}
