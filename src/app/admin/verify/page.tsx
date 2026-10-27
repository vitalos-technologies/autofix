import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Panel } from "@/components/admin-ui/panel";
import { getPlatformAdmin } from "@/lib/platform/access";
import { PlatformEnrolmentForm, PlatformMfaForm } from "../_components/forms";

export const metadata: Metadata = { title: "Verify" };

/** MFA for platform admins: /admin always needs a fresh authenticator check (AAL2); trusted devices do not count. */
export default async function PlatformVerifyPage() {
  const admin = await getPlatformAdmin();
  if (!admin) notFound();
  if (admin.access === "allowed") redirect("/admin");
  const { data } = await admin.client.auth.mfa.listFactors();
  const factor = data?.totp.find((item) => item.status === "verified");
  return (
    <div className="mx-auto w-full max-w-md">
      <h1 className="m-0 mb-4 font-display text-[32px] leading-none font-extrabold text-navy-950">
        {admin.access === "enroll" ? "Set up your authenticator" : "Two-factor authentication"}
      </h1>
      <Panel>
        <p className="m-0 text-[14px] text-grey-700">
          {admin.access === "enroll"
            ? "The platform area needs an authenticator app. Scan the code, then enter the 6-digit code it shows."
            : "Enter the 6-digit code from your authenticator app to open the platform area."}
        </p>
        {admin.access === "challenge" && factor ? <PlatformMfaForm factorId={factor.id} /> : <PlatformEnrolmentForm />}
      </Panel>
    </div>
  );
}
