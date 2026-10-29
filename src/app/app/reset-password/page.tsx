import { redirect } from "next/navigation";
import { Logo } from "@/components/layout/logo";
import { canChangeAdminPassword, requiresMfaChallenge } from "@/lib/auth/mfa";
import { getAdminContext } from "@/lib/tenancy/admin";
import { ResetPasswordForm } from "./reset-password-form";

export default async function ResetPasswordPage() {
  const admin = await getAdminContext({ requireMfa: false });
  if (!admin) redirect("/app/login?error=invalid-link");
  if (requiresMfaChallenge(admin.assurance)) {
    redirect("/app/mfa?returnTo=%2Fapp%2Freset-password&stepUp=1");
  }
  if (!canChangeAdminPassword(admin.assurance)) redirect("/app/login?error=invalid-link");
  return <main className="hero-grid grid min-h-screen place-items-center p-5"><div className="w-full max-w-md rounded-3xl bg-white p-8 shadow-2xl"><Logo /><h1 className="mt-9 text-4xl font-extrabold text-[#0f2747]">Choose a new password</h1><p className="mt-3 text-sm leading-6 text-[#64748b]">Set a strong password for your Pitline account.</p><ResetPasswordForm /></div></main>;
}
