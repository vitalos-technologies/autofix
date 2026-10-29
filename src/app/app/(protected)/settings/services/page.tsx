import type { Metadata } from "next";
import Link from "next/link";
import { ArrowDown, ArrowUp, Plus, Tag } from "lucide-react";
import { Badge, buttonClass, EmptyState, PageHeader, Panel, textLinkClass } from "@/components/admin-ui";
import { formatDuration, formatServicePrice } from "@/components/book";
import { garageShowsPrices } from "@/lib/booking-page/show-prices";
import { canManageSetup } from "@/lib/settings/setup";
import { getAdminContext } from "@/lib/tenancy/admin";
import { FlashMessage, ReadOnlyNotice, SetupNav, SetupNotice } from "../_components/setup-nav";
import { archiveServiceAction, moveServiceAction, restoreServiceAction } from "./actions";
import { loadServices, LOCATION_LABELS, type SetupService } from "./data";

export const metadata: Metadata = { title: "Services & prices" };

const MESSAGES: Record<string, string> = {
  "done:created": "Service added. Customers see it on the booking page if it is bookable online.",
  "done:updated": "Service saved.",
  "done:archived": "Service archived. Customers no longer see it; its bookings keep it.",
  "done:restored": "Service restored to the end of the list.",
  "error:not_allowed": "Only the garage's owners and managers can change services.",
  "error:not_found": "That service could not be found. It may have been changed in another tab.",
  "error:save_failed": "That change could not be saved. Try again.",
};

type PageProps = { searchParams: Promise<{ done?: string | string[]; error?: string | string[] }> };

/** Setup · Services & prices: the garage's services in booking-page order, archived ones below. */
export default async function ServicesSetupPage({ searchParams }: PageProps) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  const query = await searchParams;
  const services = admin ? await loadServices(admin.client, admin.garage.id) : { active: [], archived: [] };
  const canEdit = canManageSetup(admin?.role);
  const motEnabled = admin?.garage.motEnabled ?? false;
  const hasMot = services.active.some((service) => service.isMot);

  return (
    <div className="flex flex-col gap-5 pb-10">
      <PageHeader
        eyebrow="Setup"
        title="Services & prices"
        description="What customers can book and what it costs. The booking page lists services in this order."
        actions={
          canEdit ? (
            <Link href="/app/settings/services/new" className={buttonClass("primary")}>
              <Plus size={18} strokeWidth={2} aria-hidden="true" />
              Add a service
            </Link>
          ) : null
        }
      />
      <SetupNav current="services" />
      <FlashMessage messages={MESSAGES} done={query.done} error={query.error} />
      {!canEdit ? <ReadOnlyNotice level="manage" /> : null}
      {admin && !garageShowsPrices(admin.garage) ? (
        <SetupNotice>
          Your booking page hides prices, so customers see these services without them.{" "}
          <Link href="/app/settings/booking-page#prices" className="font-semibold underline underline-offset-2">
            Show prices
          </Link>
        </SetupNotice>
      ) : null}
      {hasMot && !motEnabled ? (
        <SetupNotice tone="warning">
          MOT is switched off, so MOT services are hidden from customers.{" "}
          <Link href="/app/settings/branding#mot" className="font-semibold text-warning-ink underline underline-offset-2">
            Turn MOT on
          </Link>
        </SetupNotice>
      ) : null}

      <Panel id="services" title="Your services" padding="flush" count={services.active.length} countLabel={`${services.active.length} services`}>
        {services.active.length ? (
          <ul className="m-0 list-none p-0">
            {services.active.map((service, index) => (
              <ServiceRow
                key={service.id}
                service={service}
                canEdit={canEdit}
                motEnabled={motEnabled}
                first={index === 0}
                last={index === services.active.length - 1}
              />
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={Tag}
            title="No services yet"
            description="Add the jobs customers can book, such as a full service or diagnostics."
            action={canEdit ? <Link href="/app/settings/services/new" className={buttonClass("primary")}>Add a service</Link> : null}
          />
        )}
      </Panel>

      {services.archived.length ? (
        <Panel id="archived" title="Archived" padding="flush" actions={<span className="text-[13px] text-grey-600">Hidden from customers</span>}>
          <ul className="m-0 list-none p-0">
            {services.archived.map((service) => (
              <li key={service.id} className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-[#eef2f6] py-3 first:border-t-0">
                <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-0.5">
                  <span className="text-[15px] font-bold text-grey-700">{service.name}</span>
                  <span className="text-[13px] text-grey-600">{serviceSummary(service)}</span>
                </div>
                {canEdit ? (
                  <form action={restoreServiceAction} className="ml-auto">
                    <input type="hidden" name="serviceId" value={service.id} />
                    <button type="submit" className={buttonClass("secondary", "sm")}>
                      Restore <span className="sr-only">{service.name}</span>
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}

function serviceSummary(service: SetupService) {
  const duration = formatDuration(service.durationMin);
  return [duration, formatServicePrice(service.pricePence, service.priceMode), LOCATION_LABELS[service.locationMode]].filter(Boolean).join(" · ");
}

function ServiceRow({ service, canEdit, motEnabled, first, last }: { service: SetupService; canEdit: boolean; motEnabled: boolean; first: boolean; last: boolean }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5 border-t border-[#eef2f6] py-3.5 first:border-t-0">
      <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-1">
        <span className="text-[15px] font-bold text-navy-950">{service.name}</span>
        <span className="text-[13px] text-grey-600">{serviceSummary(service)}</span>
        <span className="flex flex-wrap gap-1.5">
          {service.onlineEnabled ? <Badge tone="success">Bookable online</Badge> : <Badge tone="neutral">Staff only</Badge>}
          {service.needsApproval ? <Badge tone="warning">Needs your OK</Badge> : null}
          {service.isMot ? <Badge tone={motEnabled ? "info" : "muted"}>{motEnabled ? "MOT" : "MOT, hidden while MOT is off"}</Badge> : null}
        </span>
      </div>
      {canEdit ? (
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Link href={`/app/settings/services/${service.id}`} className={textLinkClass + " px-2 text-[14px]"}>
            Edit <span className="sr-only">{service.name}</span>
          </Link>
          <form action={moveServiceAction} className="flex gap-1.5">
            <input type="hidden" name="serviceId" value={service.id} />
            <button type="submit" name="direction" value="up" disabled={first} aria-label={`Move ${service.name} up`} className={buttonClass("secondary", "sm", "w-11 px-0")}>
              <ArrowUp size={18} strokeWidth={2} aria-hidden="true" />
            </button>
            <button type="submit" name="direction" value="down" disabled={last} aria-label={`Move ${service.name} down`} className={buttonClass("secondary", "sm", "w-11 px-0")}>
              <ArrowDown size={18} strokeWidth={2} aria-hidden="true" />
            </button>
          </form>
          <form action={archiveServiceAction}>
            <input type="hidden" name="serviceId" value={service.id} />
            <button type="submit" className={buttonClass("secondary", "sm")}>
              Archive <span className="sr-only">{service.name}</span>
            </button>
          </form>
        </div>
      ) : null}
    </li>
  );
}
