"use server";

import { redirect } from "next/navigation";
import { contrastRatio } from "@/lib/branding/accent";
import {
  chooseAccent,
  LOGO_EXTENSIONS,
  LOGO_MAX_BYTES,
  LOGO_TYPES,
  logoPath,
  sniffLogoType,
  type LogoType,
  type SetupFormState,
} from "@/lib/settings/setup";
import {
  afterSetupChange,
  auditSetupChange,
  databaseProblem,
  NOT_ALLOWED_MESSAGES,
  requireSetupContext,
  roleAllows,
  stateFor,
} from "@/lib/settings/server";

// Branding & MOT (P3.4): garage columns, owners only. The logo goes to the
// public-media bucket under the garage's own folder through the RLS client
// (storage policies allow only `<selected garage id>/…`).

const PATH = "/app/settings/branding";
const BUCKET = "public-media";

/** Saves the brand colour; one that white text can't be read on is darkened until it can. */
export async function saveAccentAction(previous: SetupFormState<"accent">, formData: FormData): Promise<SetupFormState<"accent">> {
  const admin = await requireSetupContext(PATH);
  if (!roleAllows(admin, "owner")) return stateFor(previous, { status: "error", message: NOT_ALLOWED_MESSAGES.owner });
  const choice = chooseAccent(String(formData.get("accent") ?? ""));
  if (!choice) return stateFor(previous, { status: "error", message: "Enter a colour as a hex code, for example #155fba.", fieldErrors: { accent: "Enter a colour as a hex code, for example #155fba." } });

  const { data, error } = await admin.client.from("garages").update({ accent: choice.saved }).eq("id", admin.garage.id).select("id").maybeSingle();
  if (error || !data) return stateFor(previous, { status: "error", message: databaseProblem(error) });

  await auditSetupChange(admin, "branding.accent_updated", "garage", admin.garage.id, { accent: choice.saved, requested: choice.requested });
  afterSetupChange(admin.garage.id, [PATH, "/app"]);
  const ratio = contrastRatio(choice.saved, "#ffffff").toFixed(1);
  return stateFor(previous, {
    status: "saved",
    message: choice.adjusted
      ? `Saved as ${choice.saved}. White text on ${choice.requested} is too faint to read, so we darkened it to ${choice.saved} (${ratio}:1).`
      : `Saved. Your booking page now uses ${choice.saved}.`,
  });
}

/** Uploads the logo (PNG, JPEG or WebP, up to 1.5 MB, checked by content) and points the garage at it. */
export async function uploadLogoAction(previous: SetupFormState<"logo">, formData: FormData): Promise<SetupFormState<"logo">> {
  const admin = await requireSetupContext(PATH);
  if (!roleAllows(admin, "owner")) return stateFor(previous, { status: "error", message: NOT_ALLOWED_MESSAGES.owner });
  const file = formData.get("logo");
  const fail = (message: string) => stateFor<"logo">(previous, { status: "error", message, fieldErrors: { logo: message } });
  if (!(file instanceof File) || file.size === 0) return fail("Choose a logo file to upload.");
  if (file.size > LOGO_MAX_BYTES) return fail("That file is over 1.5 MB. Save a smaller version and try again.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffLogoType(bytes);
  if (!type) return fail("Upload a PNG, JPEG or WebP image.");

  const path = logoPath(admin.garage.id, type);
  const storage = admin.client.storage.from(BUCKET);
  const { error: uploadError } = await storage.upload(path, bytes, { contentType: LOGO_TYPES[type], upsert: true, cacheControl: "3600" });
  if (uploadError) return fail("The logo could not be uploaded. Try again.");

  // One logo per garage: drop any earlier upload in another format.
  const others = (Object.keys(LOGO_EXTENSIONS) as LogoType[]).filter((other) => other !== type).map((other) => logoPath(admin.garage.id, other));
  await storage.remove(others);

  const { data: publicUrl } = storage.getPublicUrl(path);
  // The path is reused, so the version makes browsers and the CDN fetch the new file.
  const logoUrl = `${publicUrl.publicUrl}?v=${Date.now()}`;
  const { data, error } = await admin.client.from("garages").update({ logo_url: logoUrl }).eq("id", admin.garage.id).select("id").maybeSingle();
  if (error || !data) return fail(databaseProblem(error, "The logo was uploaded but could not be saved. Try again."));

  await auditSetupChange(admin, "branding.logo_updated", "garage", admin.garage.id, { type, bytes: file.size });
  afterSetupChange(admin.garage.id, [PATH, "/app"]);
  return stateFor(previous, { status: "saved", message: "Logo saved. It shows on your booking page now." });
}

/** Removes the logo: the booking page shows the garage's initials in its colour again. */
export async function removeLogoAction() {
  const admin = await requireSetupContext(PATH);
  if (!roleAllows(admin, "owner")) redirect(`${PATH}?error=not_allowed`);
  const { data, error } = await admin.client.from("garages").update({ logo_url: null }).eq("id", admin.garage.id).select("id").maybeSingle();
  if (error || !data) redirect(`${PATH}?error=save_failed`);
  await admin.client.storage.from(BUCKET).remove((Object.keys(LOGO_EXTENSIONS) as LogoType[]).map((type) => logoPath(admin.garage.id, type)));
  await auditSetupChange(admin, "branding.logo_removed", "garage", admin.garage.id);
  afterSetupChange(admin.garage.id, [PATH, "/app"]);
  redirect(`${PATH}?done=logo_removed`);
}

/** MOT on/off: MOT services, MOT due dates and MOT reminders appear only while it is on. */
export async function setMotEnabledAction(formData: FormData) {
  const enabled = formData.get("enabled") === "true";
  const admin = await requireSetupContext(PATH);
  if (!roleAllows(admin, "owner")) redirect(`${PATH}?error=not_allowed`);
  const { data, error } = await admin.client.from("garages").update({ mot_enabled: enabled }).eq("id", admin.garage.id).select("id").maybeSingle();
  if (error || !data) redirect(`${PATH}?error=save_failed`);
  await auditSetupChange(admin, enabled ? "mot.enabled" : "mot.disabled", "garage", admin.garage.id);
  afterSetupChange(admin.garage.id, [PATH, "/app", "/app/settings/services"]);
  redirect(`${PATH}?done=${enabled ? "mot_on" : "mot_off"}#mot`);
}
