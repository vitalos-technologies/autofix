import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { z } from "zod";
import { Badge, PageHeader, Panel, textLinkClass } from "@/components/admin-ui";
import { ServiceDepositPanel } from "@/components/payments/panels";
import { formatDuration, formatServicePrice } from "@/components/book";
import { CollectionDeliverySetting } from "@/components/courtesy/collection-setting";
import { canManageSetup } from "@/lib/settings/setup";
import { getAdminContext } from "@/lib/tenancy/admin";
import { ReadOnlyNotice } from "../../_components/setup-nav";
import { loadService, LOCATION_LABELS } from "../data";
import { ServiceForm } from "../service-form";

export const metadata: Metadata = { title: "Edit service" };

type PageProps = { params: Promise<{ id: string }>; searchParams?: Promise<{ collection?: string }> };

/** Setup · Services & prices · Edit a service (read only for technicians). */
export default async function EditServicePage({ params, searchParams }: PageProps) {
  const id = z.string().uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const admin = await getAdminContext({ allowTrustedDevice: true });
  const service = admin ? await loadService(admin.client, admin.garage.id, id.data.toLowerCase()) : null;
  if (!admin || !service) notFound();
  const canEdit = canManageSetup(admin.role);

  return (
    <div className="flex flex-col gap-5 pb-10">
      <Link href="/app/settings/services" className={`${textLinkClass} w-fit gap-1.5 text-[14px]`}>
        <ArrowLeft size={18} strokeWidth={2} aria-hidden="true" />
        All services
      </Link>
      <PageHeader eyebrow="Services & prices" title={canEdit ? `Edit ${service.name}` : service.name} />
      {canEdit ? (
        <ServiceForm initial={service} motEnabled={admin.garage.motEnabled} garageName={admin.garage.name} />
      ) : (
        <>
          <ReadOnlyNotice level="manage" />
          <Panel title="Details">
            <dl className="m-0 grid gap-3 text-[14px] sm:grid-cols-2">
              <Fact label="Price" value={formatServicePrice(service.pricePence, service.priceMode)} />
              <Fact label="How long it takes" value={formatDuration(service.durationMin) || "Not set"} />
              <Fact label="Clean-up time after" value={service.bufferMin ? formatDuration(service.bufferMin) : "None"} />
              <Fact label="Where" value={LOCATION_LABELS[service.locationMode]} />
              <Fact label="Notice needed" value={`${service.minNoticeH} hours`} />
              <Fact label="Bookable up to" value={`${service.maxDaysAhead} days ahead`} />
            </dl>
            <div className="flex flex-wrap gap-1.5">
              {service.onlineEnabled ? <Badge tone="success">Bookable online</Badge> : <Badge>Staff only</Badge>}
              {service.needsApproval ? <Badge tone="warning">Needs your OK</Badge> : null}
              {service.isMot ? <Badge tone="info">MOT</Badge> : null}
            </div>
            {service.description ? <p className="m-0 text-[14px] text-grey-700">{service.description}</p> : null}
          </Panel>
        </>
      )}
      <CollectionDeliverySetting client={admin.client} garage={admin.garage} serviceId={service.id} canEdit={canEdit} flash={(await searchParams)?.collection} />
      <ServiceDepositPanel admin={admin} serviceId={service.id} />
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[13px] text-grey-600">{label}</dt>
      <dd className="m-0 font-semibold text-navy-950">{value}</dd>
    </div>
  );
}
