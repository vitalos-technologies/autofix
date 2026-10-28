import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { PageHeader } from "@/components/admin-ui";
import { ProLockedPage } from "@/components/plans";
import { getAccountDetail } from "@/lib/accounts/queries";
import { accountFormValues } from "@/lib/accounts/view";
import { garageHasFeature } from "@/lib/plans/server";
import { canManageSetup } from "@/lib/settings/setup";
import { getAdminContext } from "@/lib/tenancy/admin";
import { AccountForm } from "../../account-form";

export const metadata: Metadata = { title: "Edit account" };

export default async function EditAccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  if (!garageHasFeature(admin.garage, "fleet_accounts")) {
    return <ProLockedPage feature="fleet_accounts" title="Edit account" canUpgrade={admin.role === "owner"} hasExistingData />;
  }
  if (!canManageSetup(admin.role)) redirect(`/app/accounts/${id}`);
  const detail = await getAccountDetail(admin.client, admin.garage.id, id);
  if (!detail) notFound();
  return (
    <div className="flex flex-col gap-5 pb-10">
      <PageHeader eyebrow="Fleet and trade accounts" title={`Edit ${detail.account.name}`} />
      <AccountForm accountId={id} values={accountFormValues(detail.account)} cancelHref={`/app/accounts/${id}`} />
    </div>
  );
}
