import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { CalendarSearch, ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import { AdminBulkActions, AdminItemCheckbox } from "@/components/admin/admin-bulk-actions";
import {
  ADMIN_SEARCH_FIELD,
  buttonClass,
  DataTable,
  EmptyState,
  PageHeader,
  Panel,
  StatusPill,
  SubmitButton,
  textLinkClass,
  type DataTableColumn,
} from "@/components/admin-ui";
import { PlateChip } from "@/components/book/plate-chip";
import { formatSlotLabel } from "@/components/book/format";
import { bookingHref, vehicleName, type AdminBooking } from "@/lib/admin/bookings";
import { AdminDataError, BOOKING_LIST_PAGE_SIZE, cleanSearch, countBookingsByStatus, listBookings } from "@/lib/admin/data";
import { formatShortDateKey } from "@/lib/admin/dates";
import { ADMIN_SEARCH_COOKIE, bookingListHref, parseBookingListParams, type BookingListParams } from "@/lib/admin/search";
import { searchAdmin } from "@/lib/admin/search-actions";
import type { BookingStatus } from "@/lib/booking-engine/types";
import { getAdminContext } from "@/lib/tenancy/admin";
import { cn } from "@/lib/utils";
import { manageTrashAction } from "../trash/actions";

export const metadata: Metadata = { title: "Bookings" };

/** Status filter chips, in workshop order. */
const STATUS_FILTERS: Array<{ status: BookingStatus | null; label: string }> = [
  { status: null, label: "All" },
  { status: "requested", label: "Needs your OK" },
  { status: "confirmed", label: "Booked" },
  { status: "arrived", label: "Arrived" },
  { status: "in_progress", label: "In bay" },
  { status: "waiting_parts", label: "Waiting parts" },
  { status: "ready", label: "Ready" },
  { status: "collected", label: "Collected" },
  { status: "cancelled", label: "Cancelled" },
  { status: "no_show", label: "No-show" },
];

const COUNTED: BookingStatus[] = ["requested"];

const fieldClass =
  "h-11 w-full min-w-0 rounded-input border border-grey-300 bg-white px-3 font-sans text-[15px] text-navy-950 focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent";

function when(booking: AdminBooking, timeZone: string) {
  return formatSlotLabel(booking.startsAt, timeZone);
}

function columns(timeZone: string): DataTableColumn<AdminBooking>[] {
  return [
    {
      key: "select",
      header: <span className="sr-only">Select</span>,
      className: "w-11",
      cell: (booking) => <AdminItemCheckbox id={booking.id} label={`Select booking ${booking.reference}`} />,
    },
    {
      key: "reference",
      header: "Booking",
      rowHeader: true,
      cell: (booking) => (
        <Link href={bookingHref(booking.id)} className={cn(textLinkClass, "min-h-0 font-mono text-[13.5px] font-medium whitespace-nowrap")}>
          {booking.reference}
        </Link>
      ),
    },
    { key: "when", header: "When", cell: (booking) => <span className="whitespace-nowrap">{when(booking, timeZone)}</span> },
    { key: "customer", header: "Customer", cell: (booking) => <span className="font-semibold text-navy-950">{booking.customerName}</span> },
    {
      key: "car",
      header: "Car",
      cell: (booking) => (
        <span className="flex items-center gap-2 whitespace-nowrap">
          {booking.registration ? <PlateChip registration={booking.registration} className="text-[13px]" /> : null}
          <span className="text-grey-600">{vehicleName(booking, false) ?? ""}</span>
        </span>
      ),
    },
    { key: "service", header: "Service", cell: (booking) => booking.serviceName },
    { key: "status", header: "Status", cell: (booking) => <StatusPill status={booking.status} size="sm" /> },
    {
      key: "booked",
      header: "Date booked",
      cell: (booking) => <span className="whitespace-nowrap text-grey-600">{formatSlotLabel(booking.createdAt, timeZone)}</span>,
    },
  ];
}

/**
 * Bookings: every booking, newest booked first, filtered by status and appointment dates (query
 * string) and searched by reference, name, mobile or registration (posted; the term stays out of
 * the URL). Reads through the garage's RLS client.
 */
export default async function BookingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  const timeZone = admin.garage.timezone || "Europe/London";
  const params = parseBookingListParams(await searchParams);
  const search = params.searched ? cleanSearch((await cookies()).get(ADMIN_SEARCH_COOKIE)?.value) : "";
  const searching = params.searched && search.length > 0;

  let result: Awaited<ReturnType<typeof listBookings>> | null = null;
  let counts: Partial<Record<BookingStatus, number>> = {};
  try {
    [result, counts] = await Promise.all([
      listBookings(admin.client, { status: params.status, from: params.from, to: params.to, search: searching ? search : null, page: params.page, timeZone }),
      countBookingsByStatus(admin.client, COUNTED),
    ]);
  } catch (error) {
    if (!(error instanceof AdminDataError)) throw error;
  }

  const pages = result ? Math.max(1, Math.ceil(result.total / (result.pageSize || BOOKING_LIST_PAGE_SIZE))) : 1;
  const filtered = Boolean(params.status || params.from || params.to || searching);
  const keep: Partial<BookingListParams> = { status: params.status, from: params.from, to: params.to, searched: searching };

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        title="Bookings"
        description="Every booking, newest first. Open one to change its status, move it or add a note."
        actions={
          <Link href="/app/bookings/new" className={buttonClass("primary", "md", "px-[18px]")}>
            <Plus size={18} strokeWidth={2.4} aria-hidden="true" />
            New booking
          </Link>
        }
      />

      <Panel title="Find bookings" headingLevel={2} className="gap-3">
        <form action={searchAdmin} role="search" className="flex flex-wrap items-end gap-2.5">
          <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-1.5">
            <label htmlFor="bookings-search" className="text-[14px] font-semibold text-grey-800">
              Reference, name, mobile or registration
            </label>
            <input
              id="bookings-search"
              name={ADMIN_SEARCH_FIELD}
              type="search"
              defaultValue={searching ? search : ""}
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="search"
              className={fieldClass}
            />
          </div>
          {params.status ? <input type="hidden" name="status" value={params.status} /> : null}
          {params.from ? <input type="hidden" name="from" value={params.from} /> : null}
          {params.to ? <input type="hidden" name="to" value={params.to} /> : null}
          <SubmitButton className={buttonClass("secondary")}>Search</SubmitButton>
        </form>

        <form method="get" action="/app/bookings" className="flex flex-wrap items-end gap-2.5">
          {params.status ? <input type="hidden" name="status" value={params.status} /> : null}
          {searching ? <input type="hidden" name="search" value="1" /> : null}
          <div className="flex min-w-0 flex-[1_1_150px] flex-col gap-1.5">
            <label htmlFor="bookings-from" className="text-[14px] font-semibold text-grey-800">
              From
            </label>
            <input id="bookings-from" name="from" type="date" defaultValue={params.from ?? ""} className={fieldClass} />
          </div>
          <div className="flex min-w-0 flex-[1_1_150px] flex-col gap-1.5">
            <label htmlFor="bookings-to" className="text-[14px] font-semibold text-grey-800">
              To
            </label>
            <input id="bookings-to" name="to" type="date" defaultValue={params.to ?? ""} className={fieldClass} />
          </div>
          <button type="submit" className={buttonClass("secondary")}>
            Show dates
          </button>
        </form>

        <nav aria-label="Filter by status" className="-mx-[18px] overflow-x-auto px-[18px]">
          <ul className="m-0 flex w-max list-none gap-2 p-0 py-1">
            {STATUS_FILTERS.map((filter) => {
              const active = params.status === filter.status;
              const count = filter.status ? counts[filter.status] : undefined;
              return (
                <li key={filter.label}>
                  <Link
                    href={bookingListHref({ ...keep, status: filter.status, page: 1 })}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "inline-flex min-h-11 items-center gap-1.5 rounded-full px-3.5 text-[13.5px] whitespace-nowrap no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                      active ? "bg-navy-950 font-bold text-white" : "border border-grey-300 bg-white font-semibold text-navy-950 hover:border-grey-600",
                    )}
                  >
                    {filter.label}
                    {count ? <span className={cn("rounded-full px-1.5 text-[12px] font-bold", active ? "bg-white text-navy-950" : "bg-accent text-accent-ink")}>{count}</span> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {filtered ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] text-grey-700">
            <p className="m-0" role="status">
              {result ? `${result.total} ${result.total === 1 ? "booking" : "bookings"}` : "Bookings"}
              {searching ? <> matching <strong className="text-navy-950">&ldquo;{search}&rdquo;</strong></> : null}
              {params.from && params.to
                ? `, ${formatShortDateKey(params.from)} to ${formatShortDateKey(params.to)}`
                : params.from
                  ? `, from ${formatShortDateKey(params.from)}`
                  : params.to
                    ? `, up to ${formatShortDateKey(params.to)}`
                    : null}
            </p>
            {searching ? (
              <form action={searchAdmin}>
                <input type="hidden" name={ADMIN_SEARCH_FIELD} value="" />
                {params.status ? <input type="hidden" name="status" value={params.status} /> : null}
                {params.from ? <input type="hidden" name="from" value={params.from} /> : null}
                {params.to ? <input type="hidden" name="to" value={params.to} /> : null}
                <SubmitButton className={cn(textLinkClass, "gap-1 border-0 bg-transparent p-0 text-[14px]")}>
                  <X size={16} strokeWidth={2} aria-hidden="true" />
                  Clear search
                </SubmitButton>
              </form>
            ) : null}
            <Link href="/app/bookings" className={cn(textLinkClass, "text-[14px]")}>
              Clear all filters
            </Link>
          </div>
        ) : null}
      </Panel>

      {!result ? (
        <div role="alert" className="rounded-card border border-[#f3c4c4] bg-[#fdecec] px-4 py-3.5 text-[14px] font-semibold text-[#991b1b]">
          Bookings could not be loaded. Refresh the page to try again.
        </div>
      ) : result.rows.length === 0 ? (
        <EmptyState
          tone="card"
          icon={CalendarSearch}
          title={filtered ? "No bookings match" : "No bookings yet"}
          description={filtered ? "Try another search, status or dates." : "Online, phone and walk-in bookings appear here as they come in."}
          action={
            filtered ? (
              <Link href="/app/bookings" className={buttonClass("secondary")}>
                Show all bookings
              </Link>
            ) : (
              <Link href="/app/bookings/new" className={buttonClass("primary")}>
                New booking
              </Link>
            )
          }
        />
      ) : (
        <AdminBulkActions entity="bookings" action={manageTrashAction}>
          <section aria-labelledby="booking-list-heading" className="mt-3.5 flex flex-col gap-3">
            <h2 id="booking-list-heading" className="sr-only">
              Booking list
            </h2>
            <p className="m-0 text-[13px] text-grey-600">Only finished bookings (collected, cancelled or no-show) can go in the trash.</p>

            {/* Phone and tablet: cards. */}
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0 lg:hidden">
              {result.rows.map((booking) => (
                <li key={booking.id} className="flex items-start gap-1 rounded-card border border-grey-200 bg-white py-2.5 pr-3.5 pl-1">
                  <AdminItemCheckbox id={booking.id} label={`Select booking ${booking.reference}`} />
                  <Link href={bookingHref(booking.id)} className="flex min-w-0 grow flex-col gap-1 rounded-[12px] py-1 text-inherit no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
                    <span className="flex flex-wrap items-center gap-2">
                      {booking.registration ? <PlateChip registration={booking.registration} /> : null}
                      <span className="text-[12.5px] text-grey-600">{vehicleName(booking, false) ?? ""}</span>
                      <StatusPill status={booking.status} size="sm" className="ml-auto" />
                    </span>
                    <span className="text-[14px] font-semibold text-grey-800">
                      {booking.customerName} · {booking.serviceName}
                    </span>
                    <span className="text-[13px] text-grey-600">
                      {when(booking, timeZone)} · <span className="font-mono">{booking.reference}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>

            {/* Desktop: table, scrolling inside its own box when narrow. */}
            <div className="hidden rounded-card border border-grey-200 bg-white px-[18px] py-2 lg:block">
              <DataTable caption="Bookings" columns={columns(timeZone)} rows={result.rows} getRowKey={(booking) => booking.id} minWidth={900} />
            </div>

            {pages > 1 ? (
              <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-3">
                <p className="m-0 text-[14px] text-grey-600">
                  Page {result.page} of {pages}
                </p>
                <div className="flex gap-2.5">
                  {result.page > 1 ? (
                    <Link href={bookingListHref({ ...keep, page: result.page - 1 })} className={buttonClass("secondary")}>
                      <ChevronLeft size={18} strokeWidth={2} aria-hidden="true" />
                      Newer
                    </Link>
                  ) : null}
                  {result.page < pages ? (
                    <Link href={bookingListHref({ ...keep, page: result.page + 1 })} className={buttonClass("secondary")}>
                      Older
                      <ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
                    </Link>
                  ) : null}
                </div>
              </nav>
            ) : null}
          </section>
        </AdminBulkActions>
      )}
    </div>
  );
}
