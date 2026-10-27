import { redirect } from "next/navigation";
import { signOut } from "@/app/app/login/actions";
import { AdminShell, defaultAdminNav, NotificationRefresher, type AdminGarage } from "@/components/admin-ui";
import { ImpersonationBanner } from "@/components/platform/impersonation-banner";
import { countOpenRequests } from "@/lib/admin/data";
import { getAdminNotificationSummary } from "@/lib/admin/notifications";
import { searchAdmin } from "@/lib/admin/search-actions";
import { getAdminContext } from "@/lib/tenancy/admin";
import { switchGarage } from "@/lib/tenancy/switch-garage";
import { garageBaseUrl } from "@/lib/tenancy/urls";

const PLAN_LABELS: Record<string, string> = { trial: "Trial", growth: "Growth plan", front_desk: "Front desk plan" };

/** Account menu links (desktop avatar, phone header). */
const ACCOUNT_LINKS = [
  { label: "Security", href: "/app/configuration/security" },
  { label: "Trash", href: "/app/trash" },
];

/**
 * Every signed-in admin page: the Autofix shell (design/screens/Admin-Dashboard.dc.html,
 * Admin-Today-Phone.dc.html). The garage is the member's selected garage (`af_garage`, checked
 * against their memberships); every count here goes through its RLS client. While a platform
 * admin views the garage as support (P4.5, read-only), the support banner sits above the shell.
 */
export default async function ProtectedAdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await getAdminContext({ requireMfa: false, allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  if (admin.mfaState === "enrollment_required") redirect("/app/mfa/enroll");
  if (admin.mfaState === "challenge_required") redirect("/app/mfa");

  const [notifications, requests] = await Promise.all([getAdminNotificationSummary(admin.client), countOpenRequests(admin.client)]);
  const garages: AdminGarage[] = admin.memberships.map((membership) => ({
    id: membership.garageId,
    name: membership.name,
    accent: membership.garageId === admin.garage.id ? admin.garage.accent : membership.accent,
    plan: PLAN_LABELS[(membership.garageId === admin.garage.id ? admin.garage.plan : membership.plan) ?? ""] ?? null,
  }));

  return (
    <>
      {admin.impersonation ? <ImpersonationBanner impersonation={admin.impersonation} /> : null}
      <AdminShell
        garages={garages}
        currentGarageId={admin.garage.id}
        switchGarageAction={switchGarage}
        nav={defaultAdminNav({ newBookings: requests, newBookingsLabel: `${requests} waiting for your OK` })}
        user={{ name: admin.profile.display_name, email: admin.user.email ?? "" }}
        bookingPageUrl={garageBaseUrl(admin.garage)}
        unreadCount={notifications.count}
        notificationsHref="/app/notifications"
        searchAction={searchAdmin}
        signOutAction={signOut}
        accountLinks={ACCOUNT_LINKS}
        extras={<NotificationRefresher count={notifications.count} />}
      >
        {children}
      </AdminShell>
    </>
  );
}
