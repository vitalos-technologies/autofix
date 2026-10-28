import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Archive, ArchiveRestore, ArrowLeft, CalendarPlus, Car, FilePlus2, FileText, Pencil, ReceiptText, Trash2, Users } from "lucide-react";
import { z } from "zod";
import { Badge, buttonClass, DataTable, EmptyState, formatDayAndTime, PageHeader, Panel, StatusPill, SubmitButton, textLinkClass, type DataTableColumn } from "@/components/admin-ui";
import { PlateChip } from "@/components/book/plate-chip";
import { ProLockedCard } from "@/components/plans";
import { formatUkPhone } from "@/lib/admin/bookings";
import { getAccountDetail, type AccountBooking, type AccountInvoiceLine, type AccountPerson, type AccountStatementSummary, type AccountVehicle } from "@/lib/accounts/queries";
import {
  ACCOUNT_KIND_LABELS,
  BILLING_LABELS,
  creditPosition,
  formatPounds,
  lineBalance,
  longDate,
  periodLabel,
  PERSON_ROLE_LABELS,
  previousStatementMonth,
  recentStatementMonths,
  STATEMENT_STATUS_LABELS,
} from "@/lib/accounts/view";
import { garageHasFeature } from "@/lib/plans/server";
import { canManageSetup } from "@/lib/settings/setup";
import { getAdminContext } from "@/lib/tenancy/admin";
import { cn } from "@/lib/utils";
import { MotDueBadge } from "../../customers/badges";
import { archiveAccountAction, generateStatementAction, removeAccountPersonAction, removeAccountVehicleAction } from "../actions";
import { AddPeoplePanel, AddVehiclesPanel } from "./account-panels";

export const metadata: Metadata = { title: "Account" };

const DONE: Record<string, string> = {
  created: "Account added. Put their cars on it next.",
  saved: "Account saved.",
  archived: "Account archived. Its cars, bookings and statements are kept.",
  restored: "Account back in use.",
  vehicle_removed: "Car taken off the account.",
  person_removed: "Taken off the account.",
};

const ERRORS: Record<string, string> = {
  not_allowed: "Only owners and managers of a garage on Pro can change accounts.",
  not_saved: "That could not be saved. Try again.",
  name_taken: "Another active account already has that name.",
  nothing_to_bill: "There are no issued invoices for this account in that month that aren't on a statement already.",
  bad_month: "Choose a month for the statement.",
  plan_required: "Fleet and trade accounts are on Pro.",
};

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[12px] font-bold tracking-[0.06em] text-grey-600 uppercase">{label}</dt>
      <dd className="m-0 text-[15px] break-words text-grey-800">{children}</dd>
    </div>
  );
}

const STATEMENT_TONES: Record<AccountStatementSummary["status"], "muted" | "warning" | "success"> = { draft: "muted", issued: "warning", paid: "success" };

/**
 * One fleet or trade account: its cars (MOT dates when the garage does MOTs), drivers and contacts,
 * recent bookings, work not yet billed and its statements. Reads go through the RLS client; another
 * garage's account is "not found". Changing anything needs an owner or manager and Pro.
 */
export default async function AccountPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string; error?: string }> }) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  const detail = await getAccountDetail(admin.client, admin.garage.id, id);
  if (!detail) notFound();
  const { account } = detail;
  const query = await searchParams;
  const done = DONE[query.done ?? ""];
  const failed = ERRORS[query.error ?? ""];
  const enabled = garageHasFeature(admin.garage, "fleet_accounts");
  const canEdit = enabled && canManageSetup(admin.role);
  const timeZone = admin.garage.timezone || "Europe/London";
  const { motEnabled } = admin.garage;
  const credit = creditPosition(account.credit_limit_pence, detail.owedPence);
  const months = recentStatementMonths(new Date(), timeZone, 6);
  const defaultMonth = previousStatementMonth(new Date(), timeZone);
  const archived = Boolean(account.archived_at);

  const vehicleColumns: DataTableColumn<AccountVehicle>[] = [
    { key: "plate", header: "Registration", rowHeader: true, cell: (vehicle) => (vehicle.registration ? <PlateChip registration={vehicle.registration} /> : "None") },
    { key: "car", header: "Car", cell: (vehicle) => [vehicle.make, vehicle.model].filter(Boolean).join(" ") || <span className="text-grey-600">Not known yet</span> },
    { key: "driver", header: "Driver", cell: (vehicle) => vehicle.driverName ?? <span className="text-grey-600">None</span> },
    ...(motEnabled ? [{ key: "mot", header: "MOT due", cell: (vehicle: AccountVehicle) => <MotDueBadge motExpiry={vehicle.motExpiry} /> }] : []),
    ...(canEdit
      ? [{
          key: "remove",
          header: <span className="sr-only">Remove</span>,
          align: "right" as const,
          cell: (vehicle: AccountVehicle) => (
            <form action={removeAccountVehicleAction}>
              <input type="hidden" name="accountId" value={account.id} />
              <input type="hidden" name="linkId" value={vehicle.linkId} />
              <SubmitButton className={buttonClass("ghost", "sm")}>
                <Trash2 size={16} strokeWidth={2} aria-hidden="true" /> Remove<span className="sr-only"> {vehicle.registration}</span>
              </SubmitButton>
            </form>
          ),
        }]
      : []),
  ];

  const bookingColumns: DataTableColumn<AccountBooking>[] = [
    { key: "ref", header: "Booking", rowHeader: true, cell: (booking) => <Link href={`/app/bookings/${booking.bookingId}`} className={textLinkClass}>{booking.reference}</Link> },
    { key: "when", header: "When", cell: (booking) => formatDayAndTime(booking.startsAt, timeZone) },
    { key: "car", header: "Car", cell: (booking) => (booking.registration ? <PlateChip registration={booking.registration} /> : "") },
    { key: "po", header: "PO", cell: (booking) => booking.poNumber ?? <span className="text-grey-600">None</span> },
    { key: "status", header: "Status", cell: (booking) => <StatusPill status={booking.status} /> },
  ];

  const unbilledColumns: DataTableColumn<AccountInvoiceLine>[] = [
    { key: "invoice", header: "Invoice", rowHeader: true, cell: (line) => <Link href={`/app/invoices/${line.invoiceId}`} className={textLinkClass}>{line.invoiceNumber ?? "Draft invoice"}</Link> },
    { key: "date", header: "Date", cell: (line) => (line.issueDate ? longDate(line.issueDate) : <span className="text-grey-600">Not issued</span>) },
    { key: "car", header: "Car", cell: (line) => (line.registration ? <PlateChip registration={line.registration} /> : "") },
    { key: "po", header: "PO", cell: (line) => line.poNumber ?? "" },
    { key: "amount", header: "Amount", align: "right", cell: (line) => formatPounds(line.totalPence) },
    { key: "balance", header: "Balance", align: "right", cell: (line) => (line.status === "draft" ? <Badge tone="muted" size="xs">Draft</Badge> : formatPounds(lineBalance(line))) },
  ];

  const peopleRow = (person: AccountPerson) => (
    <li key={person.linkId} className="flex flex-wrap items-center gap-3 border-t border-[#eef2f6] py-3 first:border-t-0">
      <span className="flex min-w-0 grow flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2">
          <Link href={`/app/customers/${person.customerId}`} className={cn(textLinkClass, "text-[15px] font-bold")}>{person.name}</Link>
          <Badge tone={person.role === "driver" ? "info" : "neutral"} size="xs">{PERSON_ROLE_LABELS[person.role]}</Badge>
        </span>
        <span className="text-[13.5px] text-grey-700">{[person.phone ? formatUkPhone(person.phone) : null, person.email].filter(Boolean).join(" · ")}</span>
      </span>
      {canEdit ? (
        <form action={removeAccountPersonAction}>
          <input type="hidden" name="accountId" value={account.id} />
          <input type="hidden" name="linkId" value={person.linkId} />
          <SubmitButton className={buttonClass("ghost", "sm")}>
            <Trash2 size={16} strokeWidth={2} aria-hidden="true" /> Remove<span className="sr-only"> {person.name}</span>
          </SubmitButton>
        </form>
      ) : null}
    </li>
  );

  return (
    <div className="flex flex-col gap-5 pb-10">
      <Link href="/app/accounts" className={cn(textLinkClass, "-mb-2 hidden gap-1.5 self-start text-[14px] lg:inline-flex")}>
        <ArrowLeft size={18} strokeWidth={2} aria-hidden="true" /> All accounts
      </Link>
      <PageHeader
        eyebrow={`${ACCOUNT_KIND_LABELS[account.kind]} account`}
        title={account.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>{BILLING_LABELS[account.billing]} · {account.payment_terms_days} days</span>
            {account.po_required ? <Badge tone="info" size="xs">PO needed</Badge> : null}
            {archived ? <Badge tone="muted" size="xs">Archived</Badge> : null}
          </span>
        }
        actions={canEdit ? (
          <div className="flex flex-wrap gap-2.5">
            {!archived ? (
              <Link href={`/app/bookings/new?account=${account.id}`} className={buttonClass("primary")}>
                <CalendarPlus size={18} strokeWidth={2} aria-hidden="true" /> Book a car
              </Link>
            ) : null}
            <Link href={`/app/accounts/${account.id}/edit`} className={buttonClass("secondary")}>
              <Pencil size={17} strokeWidth={2} aria-hidden="true" /> Edit
            </Link>
            <form action={archiveAccountAction}>
              <input type="hidden" name="accountId" value={account.id} />
              <input type="hidden" name="archive" value={archived ? "no" : "yes"} />
              <SubmitButton className={buttonClass("ghost")}>
                {archived ? <ArchiveRestore size={17} strokeWidth={2} aria-hidden="true" /> : <Archive size={17} strokeWidth={2} aria-hidden="true" />}
                {archived ? "Restore" : "Archive"}
              </SubmitButton>
            </form>
          </div>
        ) : null}
      />

      {done ? <div role="status" className="rounded-card border border-[#bfe5cb] bg-success-bg px-4 py-3.5 text-[14px] font-semibold text-success-ink">{done}</div> : null}
      {failed ? <div role="alert" className="rounded-card border border-[#f3c4c4] bg-[#fdecec] px-4 py-3.5 text-[14px] font-semibold text-[#991b1b]">{failed}</div> : null}
      {!enabled ? <ProLockedCard feature="fleet_accounts" canUpgrade={admin.role === "owner"} hasExistingData /> : null}

      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-5">
          <Panel title="Money">
            <dl className="m-0 grid grid-cols-2 gap-3.5 sm:grid-cols-4">
              <Fact label="Owed">{formatPounds(detail.owedPence)}</Fact>
              <Fact label="Credit limit">
                {account.credit_limit_pence === null ? "None" : formatPounds(account.credit_limit_pence)}
                {credit?.over ? <span className="block text-[13px] font-bold text-[#991b1b]">Over the limit</span> : null}
              </Fact>
              <Fact label="Terms">{account.payment_terms_days} days</Fact>
              <Fact label="Discount">{account.discount_percent === null ? "None" : `${Number(account.discount_percent)}%`}</Fact>
            </dl>
          </Panel>

          <Panel id="vehicles" title="Cars" count={detail.vehicles.length} countLabel="cars">
            <DataTable
              caption={`Cars on ${account.name}`}
              columns={vehicleColumns}
              rows={detail.vehicles}
              getRowKey={(vehicle) => vehicle.linkId}
              minWidth={motEnabled ? 560 : 460}
              empty={<EmptyState icon={Car} title="No cars on this account yet" description={canEdit ? "Find one of your cars or add a registration below." : undefined} />}
            />
            {canEdit && !archived ? <AddVehiclesPanel accountId={account.id} /> : null}
          </Panel>

          <Panel id="unbilled" title="Not yet on a statement" count={detail.unbilled.length + detail.toInvoice.length} countLabel="items">
            {detail.toInvoice.length ? (
              <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Bookings to invoice">
                {detail.toInvoice.map((booking) => (
                  <li key={booking.bookingId} className="flex flex-wrap items-center gap-3 rounded-input border border-grey-200 p-3">
                    {booking.registration ? <PlateChip registration={booking.registration} /> : null}
                    <span className="min-w-0 grow text-[14px] text-grey-800">
                      <Link href={`/app/bookings/${booking.bookingId}`} className={textLinkClass}>{booking.reference}</Link> · {booking.serviceName ?? "Booking"} · no invoice yet
                    </span>
                    <Link href={`/app/invoices/new?source=booking&bookingId=${booking.bookingId}`} className={buttonClass("secondary", "sm")}>
                      <FilePlus2 size={16} strokeWidth={2} aria-hidden="true" /> Invoice<span className="sr-only"> {booking.reference}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
            <DataTable
              caption={`Invoices for ${account.name} not on a statement`}
              columns={unbilledColumns}
              rows={detail.unbilled}
              getRowKey={(line) => line.invoiceId}
              minWidth={560}
              empty={detail.toInvoice.length ? undefined : <EmptyState icon={ReceiptText} title="Nothing waiting to be billed" />}
            />
          </Panel>

          <Panel title="Recent bookings" count={detail.bookings.length} countLabel="bookings">
            <DataTable
              caption={`Recent bookings for ${account.name}`}
              columns={bookingColumns}
              rows={detail.bookings}
              getRowKey={(booking) => booking.bookingId}
              minWidth={560}
              empty={<EmptyState icon={CalendarPlus} title="No bookings for this account yet" description="Book one of their cars in from New booking, choosing this account." />}
            />
          </Panel>
        </div>

        <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-5">
          <Panel id="statements" title="Statements" count={detail.statements.length} countLabel="statements">
            {detail.statements.length ? (
              <ul className="m-0 flex list-none flex-col p-0" aria-label="Statements, newest first">
                {detail.statements.map((statement) => (
                  <li key={statement.id} className="border-t border-[#eef2f6] py-3 first:border-t-0">
                    <Link href={`/app/accounts/statements/${statement.id}`} className="flex min-h-11 items-center gap-3 text-navy-950 no-underline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-accent">
                      <FileText size={18} strokeWidth={2} aria-hidden="true" className="shrink-0 text-grey-600" />
                      <span className="flex min-w-0 grow flex-col">
                        <span className="text-[15px] font-bold underline-offset-2 hover:underline">{periodLabel(statement.periodStart)}</span>
                        <span className="text-[13px] text-grey-700">{statement.reference} · {statement.invoiceCount} invoices</span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <span className="text-[14px] font-bold">{formatPounds(statement.totalPence)}</span>
                        <Badge tone={STATEMENT_TONES[statement.status]} size="xs">{STATEMENT_STATUS_LABELS[statement.status]}</Badge>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 text-[14px] text-grey-700">
                {account.billing === "monthly" ? "A draft statement is made on the 1st of each month for the month before." : "This account is invoiced job by job. You can still make a statement."}
              </p>
            )}
            {canEdit ? (
              <form action={generateStatementAction} className="flex flex-col gap-2 border-t border-[#eef2f6] pt-3.5">
                <input type="hidden" name="accountId" value={account.id} />
                <label htmlFor="statement-month" className="text-[14px] font-semibold text-grey-800">Make or refresh a statement</label>
                <div className="flex gap-2">
                  <select id="statement-month" name="month" defaultValue={defaultMonth} className="h-11 min-w-0 grow rounded-input border border-grey-300 bg-white px-3 text-[15px] text-navy-950">
                    {months.map((month) => <option key={month} value={month}>{periodLabel(month)}</option>)}
                  </select>
                  <SubmitButton className={buttonClass("secondary", "md", "shrink-0")}>Make</SubmitButton>
                </div>
              </form>
            ) : null}
          </Panel>

          <Panel id="people" title="Drivers and contacts" count={detail.people.length} countLabel="people">
            {detail.people.length ? <ul className="m-0 flex list-none flex-col p-0">{detail.people.map(peopleRow)}</ul> : <EmptyState icon={Users} title="No drivers or contacts yet" />}
            {canEdit && !archived ? <AddPeoplePanel accountId={account.id} /> : null}
          </Panel>

          <Panel title="Details">
            <dl className="m-0 grid grid-cols-1 gap-3.5">
              <Fact label="Accounts email">{account.billing_email ?? "None"}</Fact>
              <Fact label="Billing address"><span className="whitespace-pre-line">{account.billing_address ?? "None"}</span></Fact>
              <Fact label="Contact">{[account.contact_name, account.contact_phone ? formatUkPhone(account.contact_phone) : null, account.contact_email].filter(Boolean).join(" · ") || "None"}</Fact>
              {account.company_number ? <Fact label="Company number">{account.company_number}</Fact> : null}
              {account.notes ? <Fact label="Notes"><span className="whitespace-pre-line">{account.notes}</span></Fact> : null}
            </dl>
          </Panel>
        </div>
      </div>
    </div>
  );
}
