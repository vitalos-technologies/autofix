import { redirect } from "next/navigation";
import { Logo } from "@/components/layout/logo";
import { getAdminContext } from "@/lib/tenancy/admin";
import { ForgotPasswordForm } from "./forgot-password-form";

export default async function ForgotPasswordPage() {
  if (await getAdminContext()) redirect("/app");
  return <main className="hero-grid grid min-h-screen place-items-center p-5"><div className="w-full max-w-md rounded-3xl bg-white p-8 shadow-2xl"><Logo /><h1 className="mt-9 text-4xl font-extrabold text-[#0f2747]">Reset your password</h1><p className="mt-3 text-sm leading-6 text-[#64748b]">Enter your account email and we’ll send a secure recovery link.</p><ForgotPasswordForm /></div></main>;
}
