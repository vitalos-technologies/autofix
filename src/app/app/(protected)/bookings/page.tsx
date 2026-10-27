import {
  AlertTriangle,
  CalendarCheck2,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleX,
  Settings2,
} from "lucide-react";
import Link from "next/link";
import { AdminBookingListFrame } from "@/components/admin/admin-booking-list-frame";
import { AdminBulkActions, AdminItemCheckbox } from "@/components/admin/admin-bulk-actions";
import { AdminLoadingLink } from "@/components/admin/admin-loading-link";
import { AdminListFilters, AdminPagination } from "@/components/admin/admin-list-controls";
import { ADMIN_LIST_PAGE_SIZE, positiveAdminPage } from "@/lib/admin/pagination";
import { bookingStatuses, type BookingStatus } from "@/lib/booking-engine/types";
import { getAdminReadClient } from "@/lib/tenancy/admin";
import { cn } from "@/lib/utils";
import { formatRegistration } from "@/lib/vehicle/registration-format";
import { manageTrashAction } from "../trash/actions";
import { bookingStatusLabel, bookingStatusTone } from "./status";

// Kept simple until the bookings list is rebuilt (P3.3).

type Related<T> = T | T[] | null;

type AdminBookingListRow = {
  id: string;
  reference: string;
  status: BookingStatus;
  created_at: string;
  starts_at: string;
  location_mode: "workshop" | "mobile" | null;
  services: Related<{ name: string }>;
  customers: Related<{ name: string; email: string | null }>;
  vehicles: Related<{ registration: string | null; make: string | null; model: string | null }>;
};

/** Booked and still to happen. */
const activeStatuses: BookingStatus[] = ["requested", "confirmed"];
/** Released statuses do not count towards today's diary. */
const releasedStatuses: BookingStatus[] = ["cancelled", "no_show"];
const bookingViews = ["today", "upcoming", "attention", "completed", "cancelled"] as const;
type BookingView = typeof bookingViews[number];
const pageSize = ADMIN_LIST_PAGE_SIZE;

export default async function AdminBookingsPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; view?: string; page?: string }> }) {
  const params = await searchParams;
  const query = (params.q || "").trim();
  const status = bookingStatuses.includes(params.status as BookingStatus) ? params.status as BookingStatus : "";
  const view = bookingViews.includes(params.view as BookingView) ? params.view as BookingView : "";
  const requestedPage = positiveAdminPage(params.page);
  const client = await getAdminReadClient();
  const now = new Date();
  const today = dateKeyInLondon(now);
  const tomorrow = addUtcDays(today, 1);
  const todayStart = londonMidnight(today);
  const tomorrowStart = londonMidnight(tomorrow);

  const results = client ? await Promise.all([
    client
      .from("bookings")
      .select("id,reference,status,starts_at,created_at,location_mode,services(name),customers(name,email),vehicles(registration,make,model)")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(250),
    client.from("bookings").select("id", { count: "exact", head: true }).is("deleted_at", null).gte("starts_at", todayStart).lt("starts_at", tomorrowStart).not("status", "in", `(${releasedStatuses.join(",")})`),
    client.from("bookings").select("id", { count: "exact", head: true }).is("deleted_at", null).gte("starts_at", now.toISOString()).in("status", activeStatuses),
    client.from("bookings").select("id", { count: "exact", head: true }).is("deleted_at", null).eq("status", "requested"),
    client.from("bookings").select("id", { count: "exact", head: true }).is("deleted_at", null).eq("status", "collected"),
    client.from("bookings").select("id", { count: "exact", head: true }).is("deleted_at", null).eq("status", "cancelled"),
  ]) : null;

  const allBookings = (results?.[0].data || []) as unknown as AdminBookingListRow[];
  const filteredBookings = allBookings.filter((booking) => {
    const customer = relation(booking.customers);
    const vehicle = relation(booking.vehicles);
    const searchable = [booking.reference, relation(booking.services)?.name, customer?.name, customer?.email, vehicle?.registration, vehicle?.make, vehicle?.model].filter(Boolean).join(" ").toLowerCase();
    return (!query || searchable.includes(query.toLowerCase()))
      && (!status || booking.status === status)
      && matchesBookingView(booking, view, now, todayStart, tomorrowStart);
  });
  const totalPages = Math.max(1, Math.ceil(filteredBookings.length / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const bookings = filteredBookings.slice((page - 1) * pageSize, page * pageSize);

  const metrics = [
    { label: "Today", value: results?.[1].count || 0, icon: CalendarCheck2, tone: "blue", view: "today" },
    { label: "Upcoming", value: results?.[2].count || 0, icon: CalendarClock, tone: "navy", view: "upcoming" },
    { label: "Needs your OK", value: results?.[3].count || 0, icon: AlertTriangle, tone: "amber", view: "attention" },
    { label: "Collected", value: results?.[4].count || 0, icon: CheckCircle2, tone: "green", view: "completed" },
    { label: "Cancelled", value: results?.[5].count || 0, icon: CircleX, tone: "red", view: "cancelled" },
  ] as const;

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="flex items-start gap-4">
          <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-[#EAF3FF] text-[#1974E2]">
            <CalendarClock size={23} aria-hidden="true" />
          </span>
          <div>
            <p className="text-xs font-extrabold tracking-widest text-[#1974E2] uppercase">Garage appointments</p>
            <h1 className="mt-1 text-4xl font-extrabold text-[#071127]">Bookings</h1>
            <p className="mt-2 max-w-2xl text-[#667586]">Review appointment details and the bookings that need your OK.</p>
          </div>
        </div>
        <Link href="/app/service-catalogue" className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[#C9D5E2] bg-white px-4 text-sm font-extrabold text-[#1446A5] transition hover:border-[#1974E2] hover:bg-[#F1F7FF]">
          <Settings2 size={17} aria-hidden="true" /> Services
        </Link>
      </div>

      <section className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-5" aria-label="Booking summary">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <Link key={metric.label} href={view === metric.view ? "/app/bookings" : `/app/bookings?view=${metric.view}`} aria-current={view === metric.view ? "page" : undefined} className={cn("rounded-2xl border bg-white p-4 transition hover:border-[#1974E2] hover:shadow-sm focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#1974E2]/20 sm:p-5", view === metric.view ? "border-[#1974E2] ring-2 ring-[#1974E2]/15" : "border-[#E4EAF0]")}>
              <span className={cn(
                "grid size-9 place-items-center rounded-xl",
                metric.tone === "blue" && "bg-[#EAF3FF] text-[#1974E2]",
                metric.tone === "navy" && "bg-[#EEF1F7] text-[#1446A5]",
                metric.tone === "amber" && "bg-amber-100 text-amber-800",
                metric.tone === "green" && "bg-green-100 text-green-800",
                metric.tone === "red" && "bg-red-100 text-red-800",
              )}><Icon size={18} aria-hidden="true" /></span>
              <p className="mt-4 text-3xl font-extrabold text-[#071127]">{metric.value}</p>
              <p className="mt-1 text-xs font-bold text-[#667586] sm:text-sm">{metric.label}</p>
            </Link>
          );
        })}
      </section>

      <AdminListFilters action="/app/bookings" query={query} status={status} additionalParams={{ view }} placeholder="Reference, customer, vehicle or service…" statusOptions={bookingStatuses.map((value) => ({ value, label: bookingStatusLabel(value) }))} />

      <AdminBulkActions entity="bookings" action={manageTrashAction}>
      <section className="mt-8" aria-labelledby="booking-list-heading">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 id="booking-list-heading" className="text-2xl font-extrabold text-[#071127]">Appointment list</h2>
            <p className="mt-1 text-sm text-[#667586]">Bookings are ordered by date booked, newest to oldest.</p>
          </div>
          <p className="text-sm font-bold text-[#667586]">{filteredBookings.length} matching</p>
        </div>

        <AdminBookingListFrame
          key={`${page}:${query}:${status}:${view}`}
          pagination={<AdminPagination path="/app/bookings" page={page} pageSize={pageSize} totalItems={filteredBookings.length} query={query} status={status} additionalParams={{ view }} />}
        >
        <div className="mt-5 hidden max-h-[60vh] overflow-auto rounded-2xl border border-[#E4EAF0] bg-white xl:block">
          <table className="w-full min-w-[1120px] table-fixed text-left">
            <thead className="sticky top-0 z-10 bg-[#F4F7FA] text-xs font-extrabold tracking-wide text-[#586575] uppercase shadow-[0_1px_0_#E4EAF0]">
              <tr>
                <th className="w-[4%] py-4 pl-3"><span className="sr-only">Select</span></th>
                <th className="w-[11%] py-4 pl-2 pr-2">Booking ref</th>
                <th className="w-[19%] py-4 pl-2 pr-4">Customer</th>
                <th className="w-[17%] px-4 py-4">Vehicle</th>
                <th className="w-[16%] px-4 py-4">Service</th>
                <th className="w-[12%] px-4 py-4">Status</th>
                <th className="w-[15%] px-4 py-4">Date booked</th>
                <th className="w-[10%] px-4 py-4"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {bookings.map((booking) => {
                const customer = relation(booking.customers);
                const vehicle = relation(booking.vehicles);
                const bookedAt = formatBookedAt(booking.created_at);
                return (
                  <tr key={booking.id} className={cn("border-t border-[#E4EAF0] align-top transition hover:bg-[#F8FAFC]", booking.status === "requested" && "bg-amber-50/60")}>
                    <td className="py-2 pl-2"><AdminItemCheckbox id={booking.id} label={`Select booking ${booking.reference}`} /></td>
                    <td className="py-4 pl-2 pr-2 font-mono text-sm font-black text-[#1974E2]">{booking.reference}</td>
                    <td className="py-4 pl-2 pr-4"><p className="truncate text-sm font-extrabold text-[#071127]">{customer?.name || "Customer"}</p><p className="mt-1 truncate text-xs text-[#667586]">{customer?.email || "No email"}</p></td>
                    <td className="px-4 py-4 text-sm text-[#586575]">{vehicleLabel(vehicle)}</td>
                    <td className="px-4 py-4 text-sm font-semibold text-[#071127]">{relation(booking.services)?.name || "Booking"}</td>
                    <td className="px-4 py-4"><BookingStatusBadge status={booking.status} /></td>
                    <td className="px-4 py-4">
                      <time dateTime={booking.created_at} className="text-sm font-bold text-[#071127]">
                        <span className="block">{bookedAt.date}</span>
                        <span className="mt-1 block text-xs font-semibold text-[#667586]">{bookedAt.time}</span>
                      </time>
                    </td>
                    <td className="px-4 py-4">
                      <BookingOpenLink href={`/app/bookings/${booking.id}`} className="inline-flex min-h-10 items-center rounded-lg border border-[#BCD6F6] px-3 text-xs font-extrabold text-[#1446A5] hover:bg-[#F1F7FF]">View</BookingOpenLink>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-5 grid max-h-[65vh] gap-4 overflow-y-auto pr-1 xl:hidden">
          {bookings.map((booking) => {
            const customer = relation(booking.customers);
            const vehicle = relation(booking.vehicles);
            const bookedAt = formatBookedAt(booking.created_at);
            return (
              <article key={booking.id} className={cn("relative rounded-2xl border bg-white p-5 pl-14", booking.status === "requested" ? "border-amber-300" : "border-[#E4EAF0]")}>
                <div className="absolute left-2 top-3"><AdminItemCheckbox id={booking.id} label={`Select booking ${booking.reference}`} /></div>
                <BookingOpenLink href={`/app/bookings/${booking.id}`} className="block rounded-lg outline-none focus-visible:ring-4 focus-visible:ring-[#1974E2]/20">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="font-mono text-sm font-black tracking-wide text-[#1974E2]">{booking.reference}</p>
                      <h3 className="mt-2 truncate text-xl font-extrabold text-[#071127]">{customer?.name || "Customer"}</h3>
                      <time dateTime={booking.created_at} className="mt-1 block text-sm font-semibold text-[#586575]">
                        <span className="block">Booked {bookedAt.date}</span>
                        <span className="mt-0.5 block text-xs">{bookedAt.time}</span>
                      </time>
                    </div>
                    <ChevronRight className="mt-1 shrink-0 text-[#1974E2]" size={21} aria-hidden="true" />
                  </div>
                  <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-5 text-sm">
                    <ListDetail label="Vehicle" value={vehicleLabel(vehicle)} />
                    <ListDetail label="Service" value={relation(booking.services)?.name || "Booking"} />
                    <div><dt className="text-xs font-extrabold tracking-wide text-[#667586] uppercase">Status</dt><dd className="mt-2"><BookingStatusBadge status={booking.status} /></dd></div>
                  </dl>
                  <span className="sr-only">Open booking {booking.reference}</span>
                </BookingOpenLink>
              </article>
            );
          })}
        </div>

        {!bookings.length && (
          <div className="mt-5 rounded-2xl border border-[#E4EAF0] bg-white p-10 text-center">
            <CalendarClock className="mx-auto text-[#1974E2]" aria-hidden="true" />
            <h2 className="mt-4 text-xl font-bold text-[#071127]">No booking records yet</h2>
            <p className="mt-2 text-sm text-[#667586]">Appointments will appear here after a customer completes your online booking flow.</p>
          </div>
        )}
        </AdminBookingListFrame>
      </section>
      </AdminBulkActions>
    </>
  );
}

function matchesBookingView(booking: AdminBookingListRow, view: BookingView | "", now: Date, todayStart: string, tomorrowStart: string) {
  if (!view) return true;
  const appointmentTime = new Date(booking.starts_at).getTime();
  if (view === "today") return appointmentTime >= new Date(todayStart).getTime() && appointmentTime < new Date(tomorrowStart).getTime() && !releasedStatuses.includes(booking.status);
  if (view === "upcoming") return appointmentTime >= now.getTime() && activeStatuses.includes(booking.status);
  if (view === "attention") return booking.status === "requested";
  if (view === "completed") return booking.status === "collected";
  return booking.status === view;
}

function ListDetail({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-xs font-extrabold tracking-wide text-[#667586] uppercase">{label}</dt><dd className="mt-1 line-clamp-2 font-bold text-[#071127]">{value}</dd></div>;
}

function BookingOpenLink({ href, className, children }: { href: string; className: string; children: React.ReactNode }) {
  return <AdminLoadingLink href={href} className={className} loadingTitle="Opening booking" loadingDescription="Please wait while the booking details open.">{children}</AdminLoadingLink>;
}

function BookingStatusBadge({ status }: { status: BookingStatus }) {
  return <span className={cn("inline-flex rounded-full px-3 py-1.5 text-xs font-extrabold", bookingStatusTone(status))}>{bookingStatusLabel(status)}</span>;
}

function relation<T>(value: Related<T>): T | null {
  return Array.isArray(value) ? value[0] || null : value;
}

function vehicleLabel(vehicle: { registration: string | null; make: string | null; model: string | null } | null) {
  return [vehicle?.make, vehicle?.model, vehicle?.registration ? formatRegistration(vehicle.registration) : null].filter(Boolean).join(" · ") || "Vehicle not recorded";
}

function formatBookedAt(value: string) {
  const date = new Date(value);
  return {
    date: new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/London" }).format(date),
    time: new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }).format(date),
  };
}

function dateKeyInLondon(value: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/London" }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function londonMidnight(dateKey: string) {
  const [year = 0, month = 0, day = 0] = dateKey.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  for (let index = 0; index < 3; index += 1) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZone: "Europe/London",
    }).formatToParts(new Date(guess));
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value || 0);
    const represented = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour") % 24, part("minute"), part("second"));
    guess += target - represented;
  }
  return new Date(guess).toISOString();
}

function addUtcDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
