import { ArrowLeft, BellOff, CalendarClock, Car, History } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Badge,
  buttonClass,
  DataTable,
  EmptyState,
  formatDayAndTime,
  PageHeader,
  Panel,
  StatusPill,
  SubmitButton,
  textLinkClass,
  type DataTableColumn,
} from "@/components/admin-ui";
import { PlateChip } from "@/components/book/plate-chip";
import { CustomerPlansPanel } from "@/components/service-plans/panels";
import { campaignAllowed, offersStatusText } from "@/lib/consent/offers";
import { formatUkMobile } from "@/lib/customers/csv";
import { getCustomerDetail, type CustomerBooking, type CustomerVehicle } from "@/lib/customers/queries";
import { getAdminContext } from "@/lib/tenancy/admin";
import { optOutCustomerAction } from "../actions";
import { ConsentBadge, MotDueBadge } from "../badges";

export const metadata = { title: "Customer" };

const CHANNELS: Record<string, string> = { sms: "SMS", whatsapp: "WhatsApp", email: "Email" };
const ENRICHMENT: Record<NonNullable<CustomerVehicle["enrichmentStatus"]>, string> = {
  pending: "Checking DVSA",
  done: "Checked",
  not_found: "Not found at DVSA",
  failed: "DVSA check failed",
};

function formatInstant(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone }).format(new Date(value));
}

export default async function CustomerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ plans?: string; plansError?: string }> }) {
  const { id } = await params;
  const query = await searchParams;
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) notFound();
  const customer = await getCustomerDetail(admin.client, id);
  if (!customer) notFound();
  const { motEnabled, timezone } = admin.garage;

  const vehicleColumns: DataTableColumn<CustomerVehicle>[] = [
    { key: "plate", header: "Registration", rowHeader: true, cell: (vehicle) => vehicle.registration ? <PlateChip registration={vehicle.registration} /> : "None" },
    { key: "car", header: "Car", cell: (vehicle) => [vehicle.make, vehicle.model].filter(Boolean).join(" ") || <span className="text-grey-600">Not known yet</span> },
    ...(motEnabled ? [{ key: "mot", header: "MOT due", cell: (vehicle: CustomerVehicle) => <MotDueBadge motExpiry={vehicle.motExpiry} /> }] : []),
    {
      key: "checked",
      header: "Vehicle data",
      cell: (vehicle) => vehicle.enrichmentStatus
        ? <Badge tone={vehicle.enrichmentStatus === "done" ? "success" : vehicle.enrichmentStatus === "pending" ? "info" : "neutral"}>{ENRICHMENT[vehicle.enrichmentStatus]}</Badge>
        : vehicle.motCheckedAt ? <Badge tone="success">Checked</Badge> : <span className="text-grey-600">Not checked</span>,
    },
  ];

  const bookingColumns: DataTableColumn<CustomerBooking>[] = [
    {
      key: "ref",
      header: "Booking",
      rowHeader: true,
      cell: (booking) => <Link href={`/app/bookings/${booking.id}`} className={textLinkClass}>{booking.reference}</Link>,
    },
    { key: "when", header: "When", cell: (booking) => formatDayAndTime(booking.startsAt, timezone) },
    { key: "service", header: "Service", cell: (booking) => booking.serviceName ?? "" },
    { key: "car", header: "Car", cell: (booking) => booking.registration ? <PlateChip registration={booking.registration} /> : "" },
    { key: "status", header: "Status", cell: (booking) => <StatusPill status={booking.status} /> },
  ];

  const remindersOn = customer.reminderConsent && !customer.optedOutAt;
  const offersFields = {
    offersConsent: customer.offersConsent,
    reminderConsent: customer.reminderConsent,
    consentSource: customer.consentSource,
    offersOptedOutAt: customer.offersOptedOutAt,
    optedOutAt: customer.optedOutAt,
  };
  // One opt-out stops reminders and offers alike (STOP does the same).
  const canOptOut = remindersOn || campaignAllowed(offersFields);

  return (
    <div className="flex flex-col gap-5">
      <Link href="/app/customers" className={textLinkClass}>
        <ArrowLeft size={18} strokeWidth={2} aria-hidden="true" className="mr-1.5" /> All customers
      </Link>
      <PageHeader
        eyebrow="Customer"
        title={customer.name}
        description={<ConsentBadge reminderConsent={customer.reminderConsent} optedOutAt={customer.optedOutAt} />}
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Panel title="Details">
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-[14px]">
            <dt className="font-semibold text-grey-600">Mobile</dt>
            <dd className="m-0 text-navy-950"><a href={`tel:${customer.phone}`} className="font-semibold text-accent underline underline-offset-2">{formatUkMobile(customer.phone)}</a></dd>
            <dt className="font-semibold text-grey-600">Email</dt>
            <dd className="m-0 break-words text-navy-950">{customer.email ?? <span className="text-grey-600">None</span>}</dd>
            <dt className="font-semibold text-grey-600">Messages by</dt>
            <dd className="m-0 text-navy-950">{CHANNELS[customer.channel] ?? customer.channel}</dd>
            <dt className="font-semibold text-grey-600">Customer since</dt>
            <dd className="m-0 text-navy-950">{formatInstant(customer.createdAt, timezone)}</dd>
          </dl>
        </Panel>

        <Panel
          title="Reminders and consent"
          actions={canOptOut ? (
            <form action={optOutCustomerAction}>
              <input type="hidden" name="customerId" value={customer.id} />
              <SubmitButton className={buttonClass("secondary", "sm")}>
                <BellOff size={17} strokeWidth={2} aria-hidden="true" /> Opt out of reminders and offers
              </SubmitButton>
            </form>
          ) : null}
        >
          <p className="m-0 text-[14px] text-grey-700">
            {customer.optedOutAt
              ? `Opted out on ${formatInstant(customer.optedOutAt, timezone)}. No reminders or offers are sent; booking messages still are.`
              : customer.reminderConsent
                ? "This customer gets MOT and service reminders. Use the button if they ask you to stop (it stops offers too)."
                : "No reminder consent on record, so no reminders are sent."}
          </p>
          {customer.optedOutAt ? null : (
            <p className="m-0 text-[14px] text-grey-700">
              {offersStatusText(offersFields)}
            </p>
          )}
          {customer.history.length ? (
            <ol className="m-0 flex list-none flex-col gap-3 border-l-2 border-grey-200 p-0 pl-4" aria-label="Consent history">
              {customer.history.map((event, index) => (
                <li key={`${event.kind}-${event.at}-${index}`} className="flex flex-col gap-0.5 text-[14px]">
                  <span className="text-[12px] font-semibold text-grey-600">{formatInstant(event.at, timezone)}</span>
                  <span className="font-semibold text-navy-950">{event.label}</span>
                  {event.detail ? <span className="text-grey-700">{event.detail}</span> : null}
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState icon={History} title="No consent history" />
          )}
        </Panel>
      </div>

      <Panel title="Cars" count={customer.vehicles.length} countLabel="cars">
        <DataTable
          caption={`${customer.name}'s cars`}
          columns={vehicleColumns}
          rows={customer.vehicles}
          getRowKey={(vehicle) => vehicle.id}
          minWidth={520}
          empty={<EmptyState icon={Car} title="No cars on record" />}
        />
        {motEnabled && customer.vehicles.some((vehicle) => vehicle.motCheckedAt) ? (
          <p className="m-0 text-[13px] text-grey-600">MOT dates come from the DVSA MOT history and are checked again before reminders go out.</p>
        ) : null}
      </Panel>

      <CustomerPlansPanel admin={admin} customerId={customer.id} flash={{ done: query.plans, error: query.plansError }} />

      <Panel title="Bookings" count={customer.bookings.length} countLabel="bookings">
        <DataTable
          caption={`${customer.name}'s bookings`}
          columns={bookingColumns}
          rows={customer.bookings}
          getRowKey={(booking) => booking.id}
          minWidth={640}
          empty={<EmptyState icon={CalendarClock} title="No bookings yet" />}
        />
      </Panel>
    </div>
  );
}
