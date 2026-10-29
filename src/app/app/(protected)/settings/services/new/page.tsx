import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader, textLinkClass } from "@/components/admin-ui";
import { garageShowsPrices } from "@/lib/booking-page/show-prices";
import { canManageSetup } from "@/lib/settings/setup";
import { getAdminContext } from "@/lib/tenancy/admin";
import { ReadOnlyNotice } from "../../_components/setup-nav";
import { ServiceForm, type ServiceFormValues } from "../service-form";

export const metadata: Metadata = { title: "Add a service" };

const NEW_SERVICE: ServiceFormValues = {
  id: null,
  name: "",
  description: "",
  priceMode: "fixed",
  pricePence: null,
  durationMin: 60,
  bufferMin: 0,
  locationMode: "workshop",
  resourceKind: "bay",
  onlineEnabled: true,
  needsApproval: false,
  minNoticeH: 2,
  maxDaysAhead: 60,
  isMot: false,
};

/** Setup · Services & prices · Add a service. */
export default async function NewServicePage() {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  const canEdit = canManageSetup(admin?.role);
  return (
    <div className="flex flex-col gap-5 pb-10">
      <Link href="/app/settings/services" className={`${textLinkClass} w-fit gap-1.5 text-[14px]`}>
        <ArrowLeft size={18} strokeWidth={2} aria-hidden="true" />
        All services
      </Link>
      <PageHeader eyebrow="Services & prices" title="Add a service" description="Name it as customers would, then set the price and how long it takes." />
      {canEdit ? (
        <ServiceForm initial={NEW_SERVICE} motEnabled={admin?.garage.motEnabled ?? false} garageName={admin?.garage.name ?? "Your"} showPrices={admin ? garageShowsPrices(admin.garage) : true} />
      ) : (
        <ReadOnlyNotice level="manage" />
      )}
    </div>
  );
}
