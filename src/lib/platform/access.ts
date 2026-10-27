import "server-only";

import type { SupabaseClient, User } from "@supabase/supabase-js";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { platformAccess } from "@/lib/platform/policy";

export type PlatformAdmin = {
  user: User;
  /** The admin's own RLS client (no garage header). Platform data comes through the platform_* RPCs. */
  client: SupabaseClient;
  access: "allowed" | "challenge" | "enroll";
};

/**
 * The signed-in platform admin (public.platform_admins), or null for everyone
 * else. Never uses the service role: is_platform_admin() answers for auth.uid().
 */
export const getPlatformAdmin = cache(async (): Promise<PlatformAdmin | null> => {
  const client = await createClient();
  if (!client) return null;
  const { data: { user } } = await client.auth.getUser();
  if (!user) return null;
  const [{ data: isPlatformAdmin, error }, { data: assurance }] = await Promise.all([
    client.rpc("is_platform_admin"),
    client.auth.mfa.getAuthenticatorAssuranceLevel(),
  ]);
  const access = platformAccess({
    signedIn: true,
    isPlatformAdmin: !error && isPlatformAdmin === true,
    currentLevel: assurance?.currentLevel,
    nextLevel: assurance?.nextLevel,
  });
  return access === "not_found" ? null : { user, client, access };
});

/** For /admin pages: 404 unless a platform admin; MFA first when the session still owes it. */
export async function requirePlatformAdmin(): Promise<PlatformAdmin & { access: "allowed" }> {
  const admin = await getPlatformAdmin();
  if (!admin) notFound();
  if (admin.access !== "allowed") redirect("/admin/verify");
  return admin as PlatformAdmin & { access: "allowed" };
}

/** For /api/platform routes and server actions: the admin at AAL2, or null (answer 404). */
export async function getAllowedPlatformAdmin() {
  const admin = await getPlatformAdmin();
  return admin?.access === "allowed" ? admin : null;
}
