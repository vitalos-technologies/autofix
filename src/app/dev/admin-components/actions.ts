"use server";

/**
 * Stand-in for the real server actions in the dev gallery, so the gallery's forms (garage switch,
 * Accept, automation switches) submit exactly as they will once wired. It changes nothing.
 */
export async function galleryNoopAction(formData: FormData): Promise<void> {
  void formData;
}
