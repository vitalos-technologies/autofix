import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/admin-shell";
import { getAdminNotificationSummary } from "@/lib/admin/notifications";
import { getAdminContext } from "@/lib/tenancy/admin";
import { garageBaseUrl } from "@/lib/tenancy/urls";

export default async function ProtectedAdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await getAdminContext({ requireMfa: false, allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  if (admin.mfaState === "enrollment_required") redirect("/app/mfa/enroll");
  if (admin.mfaState === "challenge_required") redirect("/app/mfa");
  const notifications = await getAdminNotificationSummary(admin.client);
  return (
    <AdminShell
      displayName={admin.profile.display_name}
      notificationCount={notifications.count}
      garage={{ id: admin.garage.id, name: admin.garage.name, bookingUrl: garageBaseUrl(admin.garage) }}
      memberships={admin.memberships}
    >
      {children}
    </AdminShell>
  );
}
