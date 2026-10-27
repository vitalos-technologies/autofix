import { redirect } from "next/navigation";
import { signOut } from "@/app/app/login/actions";
import { MfaSecurityPanel } from "@/app/app/(protected)/configuration/security/mfa-security-panel";
import { Logo } from "@/components/layout/logo";
import { getAdminContext } from "@/lib/tenancy/admin";

export default async function MandatoryMfaEnrollmentPage() {
  const admin = await getAdminContext({ requireMfa: false });
  if (!admin) redirect("/app/login");
  if (admin.mfaVerified) redirect("/app");
  if (admin.mfaRequired) redirect("/app/mfa");
  return <main className="hero-grid min-h-screen p-5 sm:p-8"><div className="mx-auto w-full max-w-2xl rounded-3xl bg-white p-7 shadow-2xl sm:p-9"><Logo /><p className="mt-8 text-xs font-extrabold tracking-[0.16em] text-[#1974E2] uppercase">Restricted security setup</p><h1 className="mt-2 text-3xl font-extrabold text-[#071127]">Protect your account</h1><div className="mt-7"><MfaSecurityPanel /></div><form action={signOut} className="mt-5"><button className="min-h-11 w-full text-sm font-bold text-[#586575] hover:text-[#1974E2]">Use another account</button></form></div></main>;
}
