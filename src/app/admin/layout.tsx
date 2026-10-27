import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ImpersonationBanner } from "@/components/platform/impersonation-banner";
import { garageAccentStyle } from "@/lib/branding/accent";
import { getPlatformAdmin } from "@/lib/platform/access";
import { currentImpersonation } from "@/lib/platform/store";
import { PlatformHeader } from "./_components/platform-header";

export const metadata: Metadata = {
  title: { default: "Platform", template: "%s · Platform | Autofix" },
  robots: { index: false, follow: false },
};

/**
 * Vitalos super admin (P4.5). Platform admins only: everyone else, signed in or not, gets a 404 so the area is
 * never revealed. A platform admin still owing MFA sees only /admin/verify (pages call requirePlatformAdmin()).
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const admin = await getPlatformAdmin();
  if (!admin) notFound();
  const impersonation = admin.access === "allowed" ? await currentImpersonation(admin.client) : null;
  return (
    <div style={garageAccentStyle(null)} className="min-h-screen bg-grey-50 font-sans text-grey-800">
      {impersonation ? <ImpersonationBanner impersonation={impersonation} surface="platform" /> : null}
      <PlatformHeader email={admin.user.email ?? "Platform admin"} showNav={admin.access === "allowed"} />
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-5 px-4 py-5 lg:px-8 lg:py-8">{children}</div>
    </div>
  );
}
