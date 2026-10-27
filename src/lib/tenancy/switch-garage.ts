"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { GARAGE_COOKIE, GARAGE_COOKIE_OPTIONS, getAdminContext } from "@/lib/tenancy/admin";

const garageIdSchema = z.string().uuid().transform((value) => value.toLowerCase());

/**
 * Garage switcher (admin header form). Sets the httpOnly `af_garage` cookie
 * only for a garage the signed-in user belongs to, then reloads the admin on
 * the dashboard so no page shows another garage's record id.
 */
export async function switchGarage(formData: FormData): Promise<void> {
  const context = await getAdminContext({ requireMfa: false, allowTrustedDevice: true });
  if (!context) redirect("/app/login");
  if (context.mfaState === "enrollment_required") redirect("/app/mfa/enroll");
  if (context.mfaState === "challenge_required") redirect("/app/mfa");

  const parsed = garageIdSchema.safeParse(formData.get("garageId"));
  if (!parsed.success || !context.memberships.some((membership) => membership.garageId === parsed.data)) return;

  (await cookies()).set(GARAGE_COOKIE, parsed.data, GARAGE_COOKIE_OPTIONS);
  revalidatePath("/app", "layout");
  redirect("/app");
}
