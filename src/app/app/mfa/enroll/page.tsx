import Link from "next/link";
import { redirect } from "next/navigation";
import { signOut } from "@/app/app/login/actions";
import { MfaSecurityPanel } from "@/app/app/(protected)/configuration/security/mfa-security-panel";
import { Logo } from "@/components/layout/logo";
import { safeAdminReturnTo } from "@/lib/auth/mfa";
import { getAdminContext } from "@/lib/tenancy/admin";

/** A factor verified this recently means the owner has just enrolled here and still needs to see the recovery codes. */
const JUST_ENROLLED_MS = 5 * 60_000;

function verifiedRecently(factors: Array<{ status: string; updated_at: string }>, now = Date.now()) {
  const verifiedAt = Math.max(0, ...factors.filter((factor) => factor.status === "verified").map((factor) => Date.parse(factor.updated_at) || 0));
  return now - verifiedAt < JUST_ENROLLED_MS;
}

// `returnTo` (an /app path, checked by safeAdminReturnTo) is where a verified session goes next;
// sign-up's onboarding (P4.4) sends owners here and back.
export default async function MandatoryMfaEnrollmentPage({ searchParams }: { searchParams: Promise<{ returnTo?: string | string[] }> }) {
  const { returnTo } = await searchParams;
  const destination = safeAdminReturnTo(Array.isArray(returnTo) ? returnTo[0] : returnTo);
  const admin = await getAdminContext({ requireMfa: false });
  if (!admin) redirect("/app/login");
  // Verifying the code upgrades the session and re-renders this page in the same request (with the
  // admin context read before the upgrade). A TOTP factor verified in the last few minutes means the
  // owner has just enrolled: stay, so the panel keeps showing the recovery codes, and offer the way on.
  const { data: factors } = await admin.client.auth.mfa.listFactors();
  const justEnrolled = verifiedRecently(factors?.totp ?? []);
  if (!justEnrolled) {
    if (admin.mfaVerified) redirect(destination);
    if (admin.mfaRequired) redirect(destination === "/app" ? "/app/mfa" : `/app/mfa?returnTo=${encodeURIComponent(destination)}`);
  }
  return <main className="hero-grid min-h-screen p-5 sm:p-8"><div className="mx-auto w-full max-w-2xl rounded-3xl bg-white p-7 shadow-2xl sm:p-9"><Logo /><p className="mt-8 text-xs font-extrabold tracking-[0.16em] text-[#1974E2] uppercase">Restricted security setup</p><h1 className="mt-2 text-3xl font-extrabold text-[#071127]">Protect your account</h1><div className="mt-7"><MfaSecurityPanel /></div>{justEnrolled ? <div className="mt-5 grid gap-3 rounded-2xl border border-green-200 bg-green-50 p-5"><p className="m-0 text-sm font-bold text-green-900">Two-step verification is on. Save your recovery codes, then continue.</p><Link href={destination} className="inline-flex min-h-12 items-center justify-center rounded-lg bg-[#155FBA] px-5 text-sm font-bold text-white hover:bg-[#1974E2]">Continue</Link></div> : <form action={signOut} className="mt-5"><button className="min-h-11 w-full text-sm font-bold text-[#586575] hover:text-[#1974E2]">Use another account</button></form>}</div></main>;
}
