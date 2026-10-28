"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { isPlanRequiredDatabaseError, planRequiredMessage } from "@/lib/plans/entitlements";
import { featureProblem } from "@/lib/plans/server";
import { createGaragePayload, parseGarageDetails, parseSlug, type FieldErrors, type GarageField } from "@/lib/signup/schema";
import { createGarageError } from "@/lib/signup/server";
import { SLUG_PROBLEM_MESSAGES } from "@/lib/signup/slug";
import { getAdminContext } from "@/lib/tenancy/admin";
import { clearHostCache } from "@/lib/tenancy/resolve";
import { syncExtraSites } from "./server";

// Multi-site server actions (P5.9). Owners only, with MFA verified in this session. The group is
// always the SELECTED garage's group (the SQL functions read x-garage-id); the form carries only the
// new garage's details, or for removal the id of a site that the SQL checks is in the caller's own
// group and owned by them.

const PATH = "/app/group";
const uuid = z.string().uuid();

export type AddSiteField = Exclude<GarageField, "placeId" | "openingHours" | "website">;

export type AddSiteFormState = {
  seq: number;
  errors: FieldErrors<AddSiteField>;
  message?: string;
  added?: { name: string; slug: string; extraSites: number; billingRecorded: boolean };
};

const MESSAGES = {
  mfa: "Verify your sign-in with your authenticator app first.",
  owner: "Only the garage owner can add or remove sites.",
  unavailable: "The site could not be added. Try again.",
  limit: "You've added 3 garages in the last 24 hours. Try again tomorrow.",
  full: "Your group has the most sites it can have. Contact Vitalos.",
} as const;

async function ownerContext() {
  const admin = await getAdminContext();
  if (!admin?.mfaVerified) return { admin: null, problem: MESSAGES.mfa } as const;
  if (admin.role !== "owner") return { admin: null, problem: MESSAGES.owner } as const;
  return { admin, problem: null } as const;
}

/** Add a site: creates another garage in the selected garage's group (group_add_site()). */
export async function addSiteAction(previous: AddSiteFormState, formData: FormData): Promise<AddSiteFormState> {
  const seq = previous.seq + 1;
  const details = parseGarageDetails(formData);
  const slug = parseSlug(String(formData.get("slug") ?? ""));
  if (!details.ok || !slug.ok) {
    const errors = { ...(details.ok ? {} : details.errors), ...(slug.ok ? {} : slug.errors) } as FieldErrors<AddSiteField>;
    delete (errors as Record<string, unknown>).website;
    return { seq, errors };
  }

  const { admin, problem } = await ownerContext();
  if (!admin) return { seq, errors: {}, message: problem };
  const locked = featureProblem(admin, "multi_site");
  if (locked) return { seq, errors: {}, message: locked };

  const payload = createGaragePayload({ ...details.value, website: null, slug: slug.value, placeId: null, openingHours: [] });
  const { data, error } = await admin.client.rpc("group_add_site", { p_garage: payload });
  if (error) {
    if (isPlanRequiredDatabaseError(error)) return { seq, errors: {}, message: planRequiredMessage("multi_site") };
    if (error.code === "42501") return { seq, errors: {}, message: MESSAGES.owner };
    if (error.message?.startsWith("GROUP_FULL")) return { seq, errors: {}, message: MESSAGES.full };
    const mapped = createGarageError(error.message);
    if (mapped.code === "SLUG_TAKEN") return { seq, errors: { slug: SLUG_PROBLEM_MESSAGES.taken } };
    if (mapped.code === "SLUG_RESERVED") return { seq, errors: { slug: SLUG_PROBLEM_MESSAGES.reserved } };
    if (mapped.code === "GARAGE_LIMIT_REACHED") return { seq, errors: {}, message: MESSAGES.limit };
    if (mapped.code === "INVALID_GARAGE" && mapped.field && ["name", "phone", "email"].includes(mapped.field)) {
      return { seq, errors: { [mapped.field]: "Check this and try again." } as FieldErrors<AddSiteField> };
    }
    return { seq, errors: {}, message: MESSAGES.unavailable };
  }

  const result = data as { garage_id?: string; slug?: string; home_garage_id?: string; extra_sites?: number } | null;
  if (!result?.garage_id || !result.home_garage_id) return { seq, errors: {}, message: MESSAGES.unavailable };
  const billing = await syncExtraSites({ homeGarageId: result.home_garage_id, extraSites: Number(result.extra_sites ?? 0), actorId: admin.user.id });

  clearHostCache();
  revalidatePath("/app", "layout");
  return {
    seq,
    errors: {},
    added: { name: details.value.name, slug: result.slug ?? slug.value, extraSites: billing.extraSites, billingRecorded: billing.ok },
  };
}

/** Take a site out of the group (group_remove_site()). Nothing is deleted. */
export async function removeSiteAction(formData: FormData): Promise<void> {
  const site = uuid.safeParse(formData.get("siteId"));
  const { admin } = await ownerContext();
  if (!admin) redirect(`${PATH}?error=owner_only`);
  if (!site.success) redirect(`${PATH}?error=remove_failed`);
  if (formData.get("confirm") !== "yes") redirect(`${PATH}?confirm=${site.data}#sites`);

  const { data, error } = await admin.client.rpc("group_remove_site", { p_site_garage_id: site.data.toLowerCase() });
  if (error) redirect(`${PATH}?error=${error.message?.startsWith("GROUP_HOME_SITE") ? "home_site" : error.code === "42501" ? "owner_only" : "remove_failed"}`);
  const result = data as { home_garage_id?: string; extra_sites?: number } | null;
  let billed = true;
  if (result?.home_garage_id) {
    billed = (await syncExtraSites({ homeGarageId: result.home_garage_id, extraSites: Number(result.extra_sites ?? 0), actorId: admin.user.id })).ok;
  }
  clearHostCache();
  revalidatePath("/app", "layout");
  redirect(`${PATH}?done=${billed ? "site_removed" : "site_removed_billing"}`);
}
