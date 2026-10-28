import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/admin-ui";
import { ProLockedPage } from "@/components/plans";
import { EMPTY_ACCOUNT_FORM } from "@/lib/accounts/view";
import { garageHasFeature } from "@/lib/plans/server";
import { canManageSetup } from "@/lib/settings/setup";
import { getAdminContext } from "@/lib/tenancy/admin";
import { AccountForm } from "../account-form";

export const metadata: Metadata = { title: "New account" };

/** Add a fleet or trade account (owners and managers, Pro). */
export default async function NewAccountPage() {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  if (!garageHasFeature(admin.garage, "fleet_accounts")) {
    return <ProLockedPage feature="fleet_accounts" title="New account" canUpgrade={admin.role === "owner"} />;
  }
  if (!canManageSetup(admin.role)) redirect("/app/accounts");
  return (
    <div className="flex flex-col gap-5 pb-10">
      <PageHeader eyebrow="Fleet and trade accounts" title="New account" description="The business, who to send statements to and how they pay." />
      <AccountForm accountId={null} values={EMPTY_ACCOUNT_FORM} cancelHref="/app/accounts" />
    </div>
  );
}
