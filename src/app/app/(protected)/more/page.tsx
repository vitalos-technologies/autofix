import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Bell, ExternalLink, LogOut, Trash2 } from "lucide-react";
import { signOut } from "@/app/app/login/actions";
import { AdminNavGroups, buttonClass, defaultAdminNav, GarageSwitcher, PageHeader, SubmitButton, type AdminGarage } from "@/components/admin-ui";
import { countOpenRequests } from "@/lib/admin/data";
import { getAdminContext } from "@/lib/tenancy/admin";
import { switchGarage } from "@/lib/tenancy/switch-garage";
import { garageBaseUrl } from "@/lib/tenancy/urls";

export const metadata: Metadata = { title: "More" };

const rowClass = buttonClass("secondary", "md", "w-full justify-start gap-2.5 border-grey-200 px-2.5 text-[14px]");

/**
 * Phone "More" tab: every admin section (the sidebar groups), the garage switcher and account
 * actions. Desktop users have the sidebar, but the page works at every width.
 */
export default async function MorePage() {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  const requests = await countOpenRequests(admin.client);
  const garages: AdminGarage[] = admin.memberships.map((membership) => ({
    id: membership.garageId,
    name: membership.name,
    accent: membership.garageId === admin.garage.id ? admin.garage.accent : membership.accent,
  }));

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader title="More" />
      <section aria-labelledby="more-garage" className="flex flex-col gap-2">
        <h2 id="more-garage" className="m-0 px-2.5 font-sans text-[11px] font-bold tracking-[0.1em] text-grey-600 uppercase">
          Garage
        </h2>
        <GarageSwitcher garages={garages} currentGarageId={admin.garage.id} switchGarageAction={switchGarage} tone="light" />
        <a href={garageBaseUrl(admin.garage)} target="_blank" rel="noopener noreferrer" className={rowClass}>
          <ExternalLink size={18} strokeWidth={2} aria-hidden="true" />
          View booking page
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      </section>
      <nav aria-label="All sections">
        <AdminNavGroups groups={defaultAdminNav({ newBookings: requests, newBookingsLabel: `${requests} waiting for your OK` })} tone="light" />
      </nav>
      <section aria-labelledby="more-account" className="flex flex-col gap-0.5">
        <h2 id="more-account" className="m-0 px-2.5 font-sans pb-1.5 text-[11px] font-bold tracking-[0.1em] text-grey-600 uppercase">
          Account
        </h2>
        <p className="m-0 px-2.5 pb-2 text-[14px] text-grey-700">
          Signed in as <strong className="text-navy-950">{admin.profile.display_name}</strong>
          {admin.user.email ? <span className="block text-[13px] text-grey-600">{admin.user.email}</span> : null}
        </p>
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          <li>
            <Link href="/app/notifications" className={rowClass}>
              <Bell size={18} strokeWidth={2} aria-hidden="true" />
              Notifications
            </Link>
          </li>
          <li>
            <Link href="/app/trash" className={rowClass}>
              <Trash2 size={18} strokeWidth={2} aria-hidden="true" />
              Trash
            </Link>
          </li>
          <li>
            <form action={signOut}>
              <SubmitButton className={rowClass}>
                <LogOut size={18} strokeWidth={2} aria-hidden="true" />
                Sign out
              </SubmitButton>
            </form>
          </li>
        </ul>
      </section>
    </div>
  );
}
