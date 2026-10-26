"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getAdminUser } from "@/lib/supabase/server";

const entitySchema = z.enum(["enquiries", "bookings", "invoices", "catalogue_systems", "catalogue_services"]);
const actionSchema = z.enum(["trash", "restore", "delete"]);
const idsSchema = z.array(z.string().uuid()).min(1).max(100);

export type TrashActionResult = { success: boolean; message: string };

export async function manageTrashAction(formData: FormData): Promise<TrashActionResult> {
  const admin = await getAdminUser({ requireMfa: false, allowTrustedDevice: true });
  if (!admin) redirect("/admin/login");
  if (admin.mfaState === "enrollment_required") redirect("/admin/mfa/enroll");
  if (admin.mfaState === "challenge_required") redirect("/admin/mfa?returnTo=%2Fadmin%2Ftrash&stepUp=1");

  const parsed = z.object({
    entity: entitySchema,
    intent: actionSchema,
    ids: idsSchema,
  }).safeParse({
    entity: formData.get("entity"),
    intent: formData.get("intent"),
    ids: [...new Set(formData.getAll("ids").map(String))],
  });
  if (!parsed.success) return { success: false, message: "Choose at least one valid item." };

  const { data, error } = await admin.client.rpc("manage_admin_trash", {
    p_entity: parsed.data.entity,
    p_ids: parsed.data.ids,
    p_action: parsed.data.intent,
  });
  if (error) return { success: false, message: "The selected items could not be updated. They may be protected by linked records." };

  revalidateTrashPaths(parsed.data.entity);
  const affected = typeof data === "number" ? data : 0;
  if (parsed.data.intent === "delete" && affected < parsed.data.ids.length) {
    return { success: true, message: `${affected} deleted. Protected or non-draft linked records were kept.` };
  }
  const verb = parsed.data.intent === "trash" ? "moved to trash" : parsed.data.intent === "restore" ? "restored" : "deleted permanently";
  return { success: true, message: `${affected} ${affected === 1 ? "item" : "items"} ${verb}.` };
}

function revalidateTrashPaths(entity: z.infer<typeof entitySchema>) {
  const adminPath: Record<z.infer<typeof entitySchema>, string> = {
    enquiries: "/admin/enquiries",
    bookings: "/admin/bookings",
    invoices: "/admin/invoices",
    catalogue_systems: "/admin/service-catalogue",
    catalogue_services: "/admin/service-catalogue",
  };
  revalidatePath(adminPath[entity]);
  revalidatePath("/admin/trash");
  revalidatePath("/admin", "layout");
  revalidatePath("/book", "layout");
}
