import { redirect } from "next/navigation";
import { signOut } from "@/app/app/login/actions";
import { AdminShell, defaultAdminNav, NotificationRefresher, type AdminGarage } from "@/components/admin-ui";
import { ImpersonationBanner } from "@/components/platform/impersonation-banner";
import { countOpenRequests } from "@/lib/admin/data";
import { getAdminNotificationSummary } from "@/lib/admin/notifications";
import { searchAdmin } from "@/lib/admin/search-actions";
import { hasFeature, planLabel } from "@/lib/plans/entitlements";
import { PRO_FEATURES } from "@/lib/plans/features";
import { getAdminContext } from "@/lib/tenancy/admin";
import { switchGarage } from "@/lib/tenancy/switch-garage";
import { garageBaseUrl } from "@/lib/tenancy/urls";

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
  const now = new Date();
  const garages: AdminGarage[] = admin.memberships.map((membership) => {
    const selected = membership.garageId === admin.garage.id;
    return {
      id: membership.garageId,
      name: membership.name,
      accent: selected ? admin.garage.accent : membership.accent,
      plan: selected
        ? planLabel({ plan: admin.garage.plan, trialEndsAt: admin.garage.trialEndsAt, planChosen: admin.garage.planChosen }, now)
        : planLabel({ plan: membership.plan, trialEndsAt: membership.trialEndsAt, planChosen: membership.planChosen }, now),
    };
  });
  // P5.2: Pro sections stay in the nav for Essentials garages, with a "Pro" badge.
  const planState = { plan: admin.garage.plan, trialEndsAt: admin.garage.trialEndsAt, planChosen: admin.garage.planChosen };
  const lockedFeatures = new Set<string>(PRO_FEATURES.filter((feature) => !hasFeature(planState, feature, now)));

  return (
    <>
      {admin.impersonation ? <ImpersonationBanner impersonation={admin.impersonation} /> : null}
      <AdminShell
        garages={garages}
        currentGarageId={admin.garage.id}
        switchGarageAction={switchGarage}
        nav={defaultAdminNav({ newBookings: requests, newBookingsLabel: `${requests} waiting for your OK`, lockedFeatures })}
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
