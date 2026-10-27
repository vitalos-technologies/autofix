import {
  ArrowLeft,
  CalendarClock,
  CarFront,
  Clock3,
  History,
  Mail,
  MapPin,
  Phone,
  UserRound,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { BookingEmailThreadButton } from "@/components/admin/booking-email-thread-button";
import { MarkBookingSeen } from "@/components/admin/mark-booking-seen";
import type { BookingSource, BookingStatus } from "@/lib/booking-engine/types";
import { getAdminReadClient } from "@/lib/tenancy/admin";
import { cn } from "@/lib/utils";
import { formatRegistration } from "@/lib/vehicle/registration-format";
import { markBookingSeenAction, startBookingEnquiryThreadAction } from "../actions";
import { bookingStatusLabel, bookingStatusTone } from "../status";
import { AdminBookingControls } from "./booking-controls";

// Kept simple until the booking detail is rebuilt (P3.3).

type Related<T> = T | T[] | null;
type Customer = { name: string; email: string | null; phone: string | null };
type Vehicle = { registration: string | null; make: string | null; model: string | null; year: number | null; colour: string | null; fuel: string | null };
type BookingEvent = { id: string; type: string; actor: string; at: string; data: unknown };
type AdminBookingDetail = {
  id: string;
  reference: string;
  status: BookingStatus;
  source: BookingSource;
  starts_at: string;
  ends_at: string;
  location_mode: "workshop" | "mobile" | null;
  postcode: string | null;
  address: string | null;
  symptoms: unknown;
  notes: string | null;
  cancellation_reason: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
  services: Related<{ name: string }>;
  resources: Related<{ name: string }>;
  customers: Related<Customer>;
  vehicles: Related<Vehicle>;
};

const DETAIL_SELECT = "id,reference,status,source,starts_at,ends_at,location_mode,postcode,address,symptoms,notes,cancellation_reason,cancelled_at,created_at,updated_at,services(name),resources(name),customers(name,email,phone),vehicles(registration,make,model,year,colour,fuel)";

export default async function AdminBookingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();

  const client = await getAdminReadClient();
  if (!client) notFound();
  const [{ data, error }, { data: eventRows }] = await Promise.all([
    client.from("bookings").select(DETAIL_SELECT).eq("id", id).is("deleted_at", null).maybeSingle(),
    client.from("booking_events").select("id,type,actor,at,data").eq("booking_id", id).order("at", { ascending: false }).limit(100),
  ]);
  if (error || !data) notFound();

  const booking = data as unknown as AdminBookingDetail;
  const customer = relation(booking.customers);
  const vehicle = relation(booking.vehicles);
  const serviceName = relation(booking.services)?.name || "Booking";
  const symptoms = safeStringArray(booking.symptoms);
  const history = (eventRows || []) as BookingEvent[];

  return (
    <>
      <MarkBookingSeen bookingId={booking.id} action={markBookingSeenAction} />
      <Link href="/app/bookings" className="inline-flex min-h-10 items-center gap-2 rounded-lg text-sm font-extrabold text-[#1974E2] hover:underline">
        <ArrowLeft size={17} aria-hidden="true" /> Back to bookings
      </Link>

      <header className="mt-4 flex flex-wrap items-start justify-between gap-5">
        <div>
          <p className="font-mono text-sm font-black tracking-[.12em] text-[#1974E2]">{booking.reference}</p>
          <h1 className="mt-2 text-3xl font-extrabold text-[#071127] sm:text-4xl">{customer?.name || "Customer booking"}</h1>
          <p className="mt-2 text-[#667586]">{serviceName} · {formatAppointmentRange(booking.starts_at, booking.ends_at)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <form action={startBookingEnquiryThreadAction}>
            <input type="hidden" name="bookingId" value={booking.id} />
            <BookingEmailThreadButton label={`Email ${customer?.name || "customer"} about booking ${booking.reference}`} showLabel />
          </form>
          <BookingStatusBadge status={booking.status} />
        </div>
      </header>

      {booking.cancellation_reason && (
        <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-950">
          <strong>Cancellation note:</strong> {booking.cancellation_reason}
          {booking.cancelled_at && <span className="block text-xs text-red-800">Cancelled {formatDateTime(booking.cancelled_at)}</span>}
        </div>
      )}

      <div className="mt-7 grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,.72fr)]">
        <div className="grid min-w-0 gap-6">
          <section className="rounded-2xl border border-[#E4EAF0] bg-white p-5 sm:p-6" aria-labelledby="customer-vehicle-heading">
            <h2 id="customer-vehicle-heading" className="text-xl font-extrabold text-[#071127]">Customer and vehicle</h2>
            <div className="mt-6 grid gap-6 md:grid-cols-2">
              <DetailBlock icon={UserRound} title="Customer">
                <p className="font-extrabold text-[#071127]">{customer?.name || "Not recorded"}</p>
                {customer?.email && <a href={`mailto:${customer.email}`} className="mt-2 flex min-h-8 items-center gap-2 break-all text-sm font-semibold text-[#1974E2] hover:underline"><Mail size={15} aria-hidden="true" />{customer.email}</a>}
                {customer?.phone && <a href={`tel:${customer.phone}`} className="mt-1 flex min-h-8 items-center gap-2 text-sm font-semibold text-[#1974E2] hover:underline"><Phone size={15} aria-hidden="true" />{customer.phone}</a>}
              </DetailBlock>
              <DetailBlock icon={CarFront} title="Vehicle">
                {vehicle?.registration && <p className="inline-block rounded-md bg-[#F4C542] px-2 py-1 font-mono font-black tracking-[.1em] text-black">{formatRegistration(vehicle.registration)}</p>}
                <p className="mt-2 font-extrabold text-[#071127]">{[vehicle?.make, vehicle?.model].filter(Boolean).join(" ") || "Vehicle details not recorded"}</p>
                <p className="mt-1 text-sm leading-6 text-[#667586]">{[vehicle?.year, vehicle?.colour, vehicle?.fuel].filter(Boolean).join(" · ")}</p>
              </DetailBlock>
            </div>
          </section>

          <section className="rounded-2xl border border-[#E4EAF0] bg-white p-5 sm:p-6" aria-labelledby="service-problem-heading">
            <div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#EAF3FF] text-[#1974E2]"><Wrench size={19} aria-hidden="true" /></span><div><h2 id="service-problem-heading" className="text-xl font-extrabold text-[#071127]">Service and notes</h2><p className="mt-1 font-semibold text-[#586575]">{serviceName}</p></div></div>
            <div className="mt-5 rounded-xl bg-[#F4F7FA] p-4">
              <p className="text-xs font-extrabold tracking-wide text-[#667586] uppercase">Customer notes</p>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-[#071127]">{booking.notes || "No notes were added."}</p>
            </div>
            {symptoms.length > 0 && <div className="mt-5"><p className="text-xs font-extrabold tracking-wide text-[#667586] uppercase">Reported symptoms</p><ul className="mt-2 flex flex-wrap gap-2">{symptoms.map((symptom) => <li key={symptom} className="rounded-full bg-[#EAF3FF] px-3 py-1.5 text-xs font-bold text-[#1446A5]">{symptom}</li>)}</ul></div>}
          </section>

          <section className="rounded-2xl border border-[#E4EAF0] bg-white p-5 sm:p-6" aria-labelledby="location-heading">
            <div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#EAF3FF] text-[#1974E2]"><MapPin size={19} aria-hidden="true" /></span><div className="min-w-0"><h2 id="location-heading" className="text-xl font-extrabold text-[#071127]">Location</h2><p className="mt-1 font-bold text-[#586575]">{booking.location_mode === "mobile" ? "Mobile visit" : "At the workshop"}{relation(booking.resources)?.name ? ` · ${relation(booking.resources)?.name}` : ""}</p></div></div>
            {booking.location_mode === "mobile" && <p className="mt-5 whitespace-pre-wrap text-sm leading-7 text-[#071127]">{[booking.address, booking.postcode].filter(Boolean).join(", ") || "No address was recorded."}</p>}
          </section>
        </div>

        <aside className="grid min-w-0 content-start gap-6">
          <section className="rounded-2xl border border-[#E4EAF0] bg-white p-5 sm:p-6" aria-labelledby="appointment-heading">
            <div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#EAF3FF] text-[#1974E2]"><CalendarClock size={19} aria-hidden="true" /></span><h2 id="appointment-heading" className="pt-1 text-xl font-extrabold text-[#071127]">Appointment</h2></div>
            <dl className="mt-6 grid gap-5">
              <DetailItem label="Appointment" value={formatAppointmentRange(booking.starts_at, booking.ends_at)} />
              <DetailItem label="Booked via" value={sourceLabel(booking.source)} />
            </dl>
          </section>

          <section className="rounded-2xl border border-[#E4EAF0] bg-white p-5 sm:p-6" aria-labelledby="record-heading">
            <div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#EEF1F7] text-[#1446A5]"><Clock3 size={19} aria-hidden="true" /></span><h2 id="record-heading" className="pt-1 text-xl font-extrabold text-[#071127]">Booking record</h2></div>
            <dl className="mt-6 grid gap-5">
              <div><dt className="text-xs font-extrabold tracking-wide text-[#667586] uppercase">Status</dt><dd className="mt-2"><BookingStatusBadge status={booking.status} /></dd></div>
              <DetailItem label="Created" value={formatDateTime(booking.created_at)} />
              <DetailItem label="Updated" value={formatDateTime(booking.updated_at)} />
            </dl>
          </section>

          <AdminBookingControls bookingId={booking.id} status={booking.status} currentAppointmentStart={booking.starts_at} />
        </aside>
      </div>

      <section className="mt-6 rounded-2xl border border-[#E4EAF0] bg-white p-5 sm:p-6" aria-labelledby="history-heading">
        <div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#EEF1F7] text-[#1446A5]"><History size={19} aria-hidden="true" /></span><div><h2 id="history-heading" className="text-xl font-extrabold text-[#071127]">Booking history</h2><p className="mt-1 text-sm text-[#667586]">Customer, staff and system changes, newest first.</p></div></div>
        {history.length > 0 ? (
          <ol className="mt-6 grid gap-3">
            {history.map((entry) => {
              const detail = historyDetail(entry);
              return (
                <li key={entry.id} className="grid gap-2 rounded-xl border border-[#E4EAF0] p-4 sm:grid-cols-[1fr_auto] sm:items-start">
                  <div><p className="font-extrabold text-[#071127]">{historyTitle(entry.type)}</p>{detail && <p className="mt-1 text-sm leading-6 text-[#586575]">{detail}</p>}<p className="mt-2 text-xs font-bold text-[#667586]">By {actorLabel(entry.actor)}</p></div>
                  <time dateTime={entry.at} className="text-xs font-semibold text-[#667586] sm:text-right">{formatDateTime(entry.at)}</time>
                </li>
              );
            })}
          </ol>
        ) : <p className="mt-6 rounded-xl bg-[#F4F7FA] p-4 text-sm text-[#667586]">No history entries have been recorded.</p>}
      </section>
    </>
  );
}

function DetailBlock({ icon: Icon, title, children }: { icon: typeof UserRound; title: string; children: React.ReactNode }) {
  return <div className="flex min-w-0 gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#F1F7FF] text-[#1974E2]"><Icon size={19} aria-hidden="true" /></span><div className="min-w-0"><p className="mb-2 text-xs font-extrabold tracking-wide text-[#667586] uppercase">{title}</p>{children}</div></div>;
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-xs font-extrabold tracking-wide text-[#667586] uppercase">{label}</dt><dd className="mt-1 text-sm font-bold leading-6 text-[#071127]">{value}</dd></div>;
}

function BookingStatusBadge({ status }: { status: BookingStatus }) {
  return <span className={cn("inline-flex rounded-full px-3 py-1.5 text-xs font-extrabold", bookingStatusTone(status))}>{bookingStatusLabel(status)}</span>;
}

function relation<T>(value: Related<T>): T | null {
  return Array.isArray(value) ? value[0] || null : value;
}

function safeStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 10) : [];
}

function historyDetail(entry: BookingEvent) {
  if (!entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) return null;
  const data = entry.data as Record<string, unknown>;
  const from = typeof data.from === "string" && Number.isFinite(Date.parse(data.from)) ? data.from : null;
  const to = typeof data.to === "string" && Number.isFinite(Date.parse(data.to)) ? data.to : null;
  if (from && to) return `${formatDateTime(from)} → ${formatDateTime(to)}`;
  if (entry.type === "notification_sent" && typeof data.kind === "string") return `${String(data.kind).replaceAll("_", " ")}: ${typeof data.status === "string" ? data.status : "sent"}`;
  if (typeof data.reason === "string" && data.reason.trim()) return data.reason.trim().slice(0, 300);
  return null;
}

function historyTitle(type: string) {
  const titles: Record<string, string> = {
    created: "Booking created",
    status_changed: "Status changed",
    rescheduled: "Appointment moved",
    cancelled: "Booking cancelled",
    note: "Note added",
    notification_sent: "Customer or garage update",
  };
  return titles[type] || "Booking updated";
}

function actorLabel(actor: string) {
  return ({ customer: "customer", staff: "staff", system: "system", agent: "assistant" } as Record<string, string>)[actor] || "system";
}

function sourceLabel(source: BookingSource) {
  return ({ online: "Online booking", phone: "Phone", walk_in: "Walk-in", reminder: "Reminder", missed_call: "Missed call", ai_agent: "Assistant" } as Record<BookingSource, string>)[source] || "Online booking";
}

function formatAppointmentRange(startValue: string, endValue: string | null) {
  const start = new Date(startValue);
  const startText = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }).format(start);
  if (!endValue) return startText;
  const end = new Date(endValue);
  const sameDate = dateKey(start) === dateKey(end);
  const endText = new Intl.DateTimeFormat("en-GB", sameDate
    ? { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }
    : { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }).format(end);
  return `${startText} – ${endText}`;
}

function dateKey(value: Date) {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/London" }).format(value);
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" }).format(new Date(value));
}
