import "server-only";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { recordUserSecurityEvent } from "@/lib/admin/audit";
import { createAdminClient } from "@/lib/supabase/server";
import { getAdminContext } from "@/lib/tenancy/admin";
import {
  findValidTrustedDevice,
  generateTrustedDeviceToken,
  hashTrustedDeviceToken,
  summarizeUserAgent,
  TRUSTED_DEVICE_COOKIE,
  TRUSTED_DEVICE_COOKIE_OPTIONS,
  TRUSTED_DEVICE_LIFETIME_SECONDS,
} from "@/lib/auth/trusted-device";

export async function getCurrentTrustedDevice(userId: string, options: { touch?: boolean } = {}) {
  const client = createAdminClient();
  if (!client) return null;
  const rawToken = (await cookies()).get(TRUSTED_DEVICE_COOKIE)?.value;
  return findValidTrustedDevice(client, userId, rawToken, options);
}

export async function trustCurrentDevice(userId: string) {
  const client = createAdminClient();
  if (!client) return false;
  const rawToken = generateTrustedDeviceToken();
  const tokenHash = await hashTrustedDeviceToken(rawToken);
  const userAgent = (await headers()).get("user-agent");
  const deviceLabel = summarizeUserAgent(userAgent);
  const expiresAt = new Date(Date.now() + TRUSTED_DEVICE_LIFETIME_SECONDS * 1000).toISOString();
  const { data, error } = await client.from("admin_trusted_devices").insert({
    user_id: userId,
    token_hash: tokenHash,
    device_label: deviceLabel,
    user_agent_summary: deviceLabel,
    expires_at: expiresAt,
  }).select("id").single();
  if (error || !data) return false;
  const audited = await recordUserSecurityEvent(userId, "mfa_trusted_device_added", { deviceLabel, expiresAt }, { type: "admin_trusted_device", id: data.id }, client);
  if (!audited) {
    await client.from("admin_trusted_devices").delete().eq("id", data.id).eq("user_id", userId);
    return false;
  }
  (await cookies()).set(TRUSTED_DEVICE_COOKIE, rawToken, TRUSTED_DEVICE_COOKIE_OPTIONS);
  return true;
}

export async function clearTrustedDeviceCookie() {
  (await cookies()).set(TRUSTED_DEVICE_COOKIE, "", { ...TRUSTED_DEVICE_COOKIE_OPTIONS, maxAge: 0 });
}

export async function requireFreshAdminSession(returnTo = "/app") {
  const admin = await getAdminContext({ requireMfa: false });
  if (admin?.mfaRequired && !admin.mfaVerified) {
    redirect(`/app/mfa?returnTo=${encodeURIComponent(returnTo)}&stepUp=1`);
  }
  return admin;
}

export async function revokeAllTrustedDevices(userId: string, action = "mfa_trusted_devices_revoked_all") {
  const client = createAdminClient();
  if (!client) return false;
  const revokedAt = new Date().toISOString();
  const { error } = await client.from("admin_trusted_devices").update({ revoked_at: revokedAt }).eq("user_id", userId).is("revoked_at", null);
  if (error) return false;
  await recordUserSecurityEvent(userId, action, {}, {}, client);
  await clearTrustedDeviceCookie();
  return true;
}
