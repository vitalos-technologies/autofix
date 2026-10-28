"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireStaffWriter } from "@/lib/admin/staff";
import { featureProblem } from "@/lib/plans/server";
import { ASSIGN_MESSAGES, assignTechnician } from "@/lib/reports/assignments";
import { canManageSetup } from "@/lib/settings/setup";

// P5.6: "Who did the job" on the booking page (owners/managers, Pro). The garage is the member's
// selected garage; assign_booking_technician() checks the role, the plan and that the person is a
// member, through the RLS client.

export type TechnicianState = { status: "idle" | "done" | "error"; message: string };

const schema = z.object({
  bookingId: z.string().uuid(),
  technicianId: z.union([z.literal(""), z.string().uuid()]),
});

export async function assignTechnicianAction(_previous: TechnicianState, formData: FormData): Promise<TechnicianState> {
  const parsed = schema.safeParse({ bookingId: formData.get("bookingId"), technicianId: formData.get("technicianId") ?? "" });
  if (!parsed.success) return { status: "error", message: ASSIGN_MESSAGES.not_member };
  const admin = await requireStaffWriter(`/app/bookings/${parsed.data.bookingId}`);
  if (!canManageSetup(admin.role)) return { status: "error", message: ASSIGN_MESSAGES.not_allowed };
  const locked = featureProblem(admin, "advanced_reports");
  if (locked) return { status: "error", message: locked };

  const result = await assignTechnician(admin.client, parsed.data.bookingId, parsed.data.technicianId || null);
  if (!result.ok) return { status: "error", message: result.message };
  revalidatePath(`/app/bookings/${parsed.data.bookingId}`);
  revalidatePath("/app/reports");
  return { status: "done", message: result.name ? `Saved: ${result.name} did this job.` : "Saved: nobody is down for this job." };
}
