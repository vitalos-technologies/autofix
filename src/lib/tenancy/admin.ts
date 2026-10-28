import "server-only";

import type { AuthMFAGetAuthenticatorAssuranceLevelResponse, SupabaseClient, User } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import { cache } from "react";
import { requiresMfaChallenge } from "@/lib/auth/mfa";
import { isMandatoryAdminMfaEnabled } from "@/lib/auth/mfa-policy";
import { findValidTrustedDevice, TRUSTED_DEVICE_COOKIE } from "@/lib/auth/trusted-device";
import { IMPERSONATION_COOKIE, isPrefetch, isReadRequest, toImpersonation, type Impersonation, type ImpersonationRow } from "@/lib/platform/policy";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { GARAGE_SELECT, garageFromRow, type Garage, type GarageRow } from "@/lib/tenancy/garage";
import { REQUEST_PATH_HEADER } from "@/lib/tenancy/request-headers";

/** httpOnly cookie holding the admin's selected garage id. Always re-validated against memberships. */
export const GARAGE_COOKIE = "af_garage";
/** The request header PostgREST exposes to `public.request_garage_id()`. */
export const GARAGE_HEADER = "x-garage-id";

export const GARAGE_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 24 * 180,
};

export type GarageRole = "owner" | "manager" | "technician" | "front_desk";
export type GarageMembership = {
  garageId: string;
  name: string;
  role: GarageRole;
  /** `garages.accent`, for the switcher tile (the only garage branding in the admin). */
  accent?: string | null;
  /** `garages.plan` (`essentials`/`pro`, P5.2), with the trial end and the plan chosen, for the switcher label. */
  plan?: string | null;
  trialEndsAt?: string | null;
  planChosen?: string | null;
};
export type AdminProfile = { user_id: string; display_name: string };
type AssuranceLevel = NonNullable<AuthMFAGetAuthenticatorAssuranceLevelResponse["data"]>;
type TrustedDevice = Awaited<ReturnType<typeof findValidTrustedDevice>>;

export type AdminMfaState = "verified" | "trusted" | "challenge_required" | "enrollment_required" | "unenrolled_allowed";

export type AdminContext = {
  user: User;
  profile: AdminProfile;
  /** The selected garage (from `af_garage`, validated), or the first membership. */
  garage: Garage;
  role: GarageRole;
  /** Every garage the user works for, for the switcher. */
  memberships: GarageMembership[];
  /** RLS client that sends the selected garage as `x-garage-id`. */
  client: SupabaseClient;
  assurance: AssuranceLevel;
  mfaRequired: boolean;
  mfaVerified: boolean;
  mandatoryMfa: boolean;
  mfaState: AdminMfaState;
  trustedDevice: TrustedDevice;
  /**
   * A Vitalos platform admin viewing this garage as support (P4.5), or null.
   * Read-only: the database admits the session only in read-only transactions
   * and server actions get no context at all while it lasts. Render
   * `ImpersonationBanner` (src/components/platform) when set.
   */
  impersonation: Impersonation | null;
};

export type AdminContextOptions = {
  /** Reject sessions that still owe an MFA challenge or enrolment (default true). */
  requireMfa?: boolean;
  /** Let a remembered device stand in for the MFA challenge (reads only; invoice RPCs still need AAL2). */
  allowTrustedDevice?: boolean;
};

const ROLES = new Set<GarageRole>(["owner", "manager", "technician", "front_desk"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MembershipGarage = {
  id: string;
  name: string;
  status: string;
  accent?: string | null;
  plan?: string | null;
  trial_ends_at?: string | null;
  plan_chosen?: string | null;
};

type MembershipRow = {
  garage_id: string;
  role: string;
  created_at?: string | null;
  garage: MembershipGarage | MembershipGarage[] | null;
};

/**
 * The RLS client for one garage: the user's session plus `x-garage-id`.
 * The database honours the header only for members of that garage, so a
 * garage the user does not belong to simply yields zero rows.
 */
export async function createGarageClient(garageId: string) {
  return createClient({ headers: { [GARAGE_HEADER]: garageId } });
}

/** Picks the cookie's garage when the user belongs to it, else the first membership. */
export function selectGarage(memberships: GarageMembership[], requestedGarageId: string | null | undefined) {
  const requested = requestedGarageId && UUID_PATTERN.test(requestedGarageId)
    ? memberships.find((membership) => membership.garageId === requestedGarageId.toLowerCase())
    : undefined;
  return requested ?? memberships[0] ?? null;
}

function relation<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function displayNameFor(user: User, profile: { display_name?: string | null } | null) {
  const fromProfile = profile?.display_name?.trim();
  if (fromProfile) return fromProfile;
  const fromMetadata = typeof user.user_metadata?.display_name === "string" ? user.user_metadata.display_name.trim() : "";
  if (fromMetadata) return fromMetadata.slice(0, 100);
  return user.email?.split("@")[0]?.slice(0, 100) || "Garage staff";
}

/** The user's garages, oldest membership first. Cancelled garages are left out. */
export async function loadMemberships(client: SupabaseClient, userId: string): Promise<GarageMembership[]> {
  const { data, error } = await client
    .from("garage_members")
    .select("garage_id,role,created_at,garage:garages!inner(id,name,status,accent,plan,trial_ends_at,plan_chosen)")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error || !data) return [];
  return (data as unknown as MembershipRow[]).flatMap((row) => {
    const garage = relation(row.garage);
    if (!garage || garage.status === "cancelled" || !ROLES.has(row.role as GarageRole)) return [];
    return [{
      garageId: String(row.garage_id).toLowerCase(),
      name: garage.name,
      role: row.role as GarageRole,
      accent: garage.accent ?? null,
      plan: garage.plan ?? null,
      trialEndsAt: garage.trial_ends_at ?? null,
      planChosen: garage.plan_chosen ?? null,
    }];
  });
}

/**
 * The platform admin's impersonated garage (P4.5), when the hint cookie is set
 * and current_impersonation() returns an open session. `undefined` means no
 * session (load the user's own garages); `null` means the request is a write
 * (server action or non-GET), which is refused and logged.
 */
async function loadImpersonation(base: SupabaseClient): Promise<{ session: Impersonation; path: string | null } | null | undefined> {
  const { data, error } = await base.rpc("current_impersonation");
  const session = error ? null : toImpersonation(((data ?? []) as ImpersonationRow[])[0]);
  if (!session) return undefined;
  const requestHeaders = await headers();
  const path = requestHeaders.get(REQUEST_PATH_HEADER);
  if (!isReadRequest(requestHeaders)) {
    await base.rpc("log_impersonation_event", { p_action: "platform.impersonation_write_blocked", p_path: path });
    return null;
  }
  if (!isPrefetch(requestHeaders)) {
    await base.rpc("log_impersonation_event", { p_action: "platform.impersonation_page_view", p_path: path });
  }
  return { session, path };
}

const loadAdminIdentity = cache(async () => {
  // Read the request cookies first, even when Supabase is not configured, so
  // every admin route is rendered per request and never prerendered at build.
  const cookieStore = await cookies();
  const base = await createClient();
  if (!base) return null;
  const { data: { user } } = await base.auth.getUser();
  if (!user) return null;

  const impersonated = cookieStore.get(IMPERSONATION_COOKIE) ? await loadImpersonation(base) : undefined;
  if (impersonated === null) return null;
  const impersonation = impersonated?.session ?? null;

  // While impersonating, the impersonated garage is the only one, read as owner (read-only).
  const memberships = impersonation
    ? [{ garageId: impersonation.garageId, name: impersonation.garageName, role: "owner" as const }]
    : await loadMemberships(base, user.id);
  const selected = selectGarage(memberships, impersonation ? impersonation.garageId : cookieStore.get(GARAGE_COOKIE)?.value);
  if (!selected) return null;

  const client = await createGarageClient(selected.garageId);
  if (!client) return null;
  const [{ data: garageRow, error: garageError }, { data: profileRow }, { data: assurance, error: assuranceError }] = await Promise.all([
    client.from("garages").select(GARAGE_SELECT).eq("id", selected.garageId).maybeSingle(),
    base.from("admin_profiles").select("user_id,display_name").eq("user_id", user.id).maybeSingle(),
    base.auth.mfa.getAuthenticatorAssuranceLevel(),
  ]);
  if (garageError || !garageRow || assuranceError || !assurance) return null;

  const service = createAdminClient();
  const mandatoryMfa = await isMandatoryAdminMfaEnabled(service);
  const trustedDeviceToken = cookieStore.get(TRUSTED_DEVICE_COOKIE)?.value;
  return {
    user,
    profile: { user_id: user.id, display_name: displayNameFor(user, profileRow as { display_name?: string | null } | null) },
    garage: garageFromRow(garageRow as GarageRow),
    role: selected.role,
    memberships,
    client,
    assurance,
    mandatoryMfa,
    service,
    trustedDeviceToken,
    impersonation,
  };
});

const loadTrustedDevice = cache(async (userId: string) => {
  const identity = await loadAdminIdentity();
  if (!identity?.service) return null;
  return findValidTrustedDevice(identity.service, userId, identity.trustedDeviceToken);
});

/**
 * The signed-in garage member, their selected garage and an RLS client for it.
 * Returns null for signed-out users and for users who belong to no garage.
 * MFA rules are SOB's: with `requireMfa` (default) a session that still owes a
 * challenge (unless a trusted device is allowed and present) or a mandatory
 * enrolment is rejected.
 */
export async function getAdminContext(options: AdminContextOptions = {}): Promise<AdminContext | null> {
  const requireMfa = options.requireMfa ?? true;
  const identity = await loadAdminIdentity();
  if (!identity) return null;
  const { assurance, mandatoryMfa } = identity;
  const mfaRequired = assurance.nextLevel === "aal2";
  const mfaVerified = assurance.currentLevel === "aal2";
  const trustedDevice = options.allowTrustedDevice && requiresMfaChallenge(assurance)
    ? await loadTrustedDevice(identity.user.id)
    : null;
  if (requireMfa && requiresMfaChallenge(assurance) && !trustedDevice) return null;
  if (requireMfa && mandatoryMfa && !mfaRequired && !mfaVerified) return null;
  const mfaState: AdminMfaState = mfaVerified
    ? "verified"
    : requiresMfaChallenge(assurance)
      ? trustedDevice ? "trusted" : "challenge_required"
      : mandatoryMfa ? "enrollment_required" : "unenrolled_allowed";
  return {
    user: identity.user,
    profile: identity.profile,
    garage: identity.garage,
    role: identity.role,
    memberships: identity.memberships,
    client: identity.client,
    assurance,
    mfaRequired,
    mfaVerified,
    mandatoryMfa,
    mfaState,
    trustedDevice,
    impersonation: identity.impersonation,
  };
}

/** For admin pages that only read: the RLS garage client, or null when the session may not read yet. */
export async function getAdminReadClient() {
  const context = await getAdminContext({ allowTrustedDevice: true });
  return context?.client ?? null;
}

// The garage switcher's server action lives in `./switch-garage` ("use server"
// modules may only export async functions).
