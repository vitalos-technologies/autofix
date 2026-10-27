"use server";

import { redirect } from "next/navigation";
import { clientIp } from "@/lib/booking-flow/server";
import { getGarage } from "@/lib/tenancy/garage";
import type { UnsubscribeFormState } from "./forms";
import { optOutByPhone, resumeWithToken } from "./unsubscribe";

// Server actions for the unsubscribe page on the garage host. The garage is
// the request host's (getGarage); the number is only ever in the POST body.

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/;

/** The form without a link: the same answer whether or not the number is on file. */
export async function unsubscribeFormAction(previous: UnsubscribeFormState, formData: FormData): Promise<UnsubscribeFormState> {
  const garage = await getGarage();
  const phone = formData.get("phone");
  const result = await optOutByPhone(garage, typeof phone === "string" ? phone.slice(0, 40) : "", await clientIp());
  return { status: result.status, seq: previous.seq + 1 };
}

/** "Turn reminders back on" from a signed link. */
export async function resumeRemindersAction(formData: FormData): Promise<void> {
  const garage = await getGarage();
  const raw = formData.get("token");
  const token = typeof raw === "string" && TOKEN_SHAPE.test(raw) ? raw : null;
  if (!token) redirect("/unsubscribe");
  const result = await resumeWithToken(garage, token);
  if (result.status === "resumed") redirect(`/unsubscribe/${token}/resumed`);
  redirect(result.status === "invalid_link" ? "/unsubscribe" : `/unsubscribe/${token}?retry=1`);
}
