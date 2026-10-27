"use server";

import { redirect } from "next/navigation";
import { ONBOARDING_PATHS } from "@/components/onboarding/steps";
import { afterSetupChange, auditSetupChange } from "@/lib/settings/server";
import { requireOnboardingOwner } from "./context";

// Onboarding steps 4 and 6 (P4.4). Writes go through the owner's RLS client for the selected
// garage; the garage id never comes from the form.

/** Step 4: MOT on/off and which of the seeded services to keep (unticked ones are archived, restorable in Setup). */
export async function saveOnboardingServicesAction(formData: FormData): Promise<void> {
  const admin = await requireOnboardingOwner(ONBOARDING_PATHS.services);
  const motEnabled = formData.get("mot") === "yes";
  const keep = new Set(formData.getAll("service").map(String));
  if (!keep.size) redirect(`${ONBOARDING_PATHS.services}?error=none_kept`);

  const { data: services, error: loadError } = await admin.client
    .from("services")
    .select("id,is_mot,deleted_at")
    .eq("garage_id", admin.garage.id);
  if (loadError || !services) redirect(`${ONBOARDING_PATHS.services}?error=save_failed`);

  const { error: garageError } = await admin.client.from("garages").update({ mot_enabled: motEnabled }).eq("id", admin.garage.id);
  if (garageError) redirect(`${ONBOARDING_PATHS.services}?error=save_failed`);

  const now = new Date().toISOString();
  for (const service of services as Array<{ id: string; is_mot: boolean; deleted_at: string | null }>) {
    // The MOT service follows the MOT switch (it is never bookable while MOT is off).
    const wanted = service.is_mot ? motEnabled : keep.has(service.id);
    const archived = service.deleted_at !== null;
    if (wanted === !archived) continue;
    const { error } = await admin.client
      .from("services")
      .update(wanted ? { deleted_at: null, deleted_by: null } : { deleted_at: now, deleted_by: admin.user.id })
      .eq("garage_id", admin.garage.id)
      .eq("id", service.id);
    if (error) redirect(`${ONBOARDING_PATHS.services}?error=save_failed`);
  }

  await auditSetupChange(admin, "onboarding.services_saved", "garage", admin.garage.id, { mot_enabled: motEnabled, services_kept: keep.size });
  afterSetupChange(admin.garage.id, ["/app/settings/services"]);
  redirect(ONBOARDING_PATHS.agreement);
}

/** Step 6 → done: the garage goes live (`complete_garage_onboarding()` checks owner, MFA and the DPA). */
export async function finishOnboardingAction(): Promise<void> {
  const admin = await requireOnboardingOwner(ONBOARDING_PATHS.team);
  const { error } = await admin.client.rpc("complete_garage_onboarding");
  if (error) redirect(error.message?.startsWith("DPA_NOT_ACCEPTED") ? `${ONBOARDING_PATHS.agreement}?error=dpa_required` : `${ONBOARDING_PATHS.team}?error=finish_failed`);
  afterSetupChange(admin.garage.id, ["/app"]);
  redirect(ONBOARDING_PATHS.done);
}
