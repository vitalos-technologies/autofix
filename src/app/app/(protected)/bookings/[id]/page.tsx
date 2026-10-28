import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, CalendarClock, Check, History, Mail, MessageSquare, Phone, StickyNote, X } from "lucide-react";
import { z } from "zod";
import { BookingEmailThreadButton } from "@/components/admin/booking-email-thread-button";
import { MarkBookingSeen } from "@/components/admin/mark-booking-seen";
import { PageHeader, Panel, SOURCE_LABELS, StatusPill, textLinkClass } from "@/components/admin-ui";
import { formatServicePrice, formatSlotLabel, formatTime } from "@/components/book/format";
import { PlateChip } from "@/components/book/plate-chip";
import { CHANGE_MESSAGES } from "@/lib/admin/booking-changes";
import { getBookingAccount } from "@/lib/accounts/queries";
import { formatUkPhone, telLink, vehicleName } from "@/lib/admin/bookings";
import { AdminDataError, loadBookingDetail, loadOpeningHours } from "@/lib/admin/data";
import { addDays, isoWeekday, localDateKey } from "@/lib/admin/dates";
import { timelineEntry, type TimelineKind } from "@/lib/admin/timeline";
import { getAdminContext } from "@/lib/tenancy/admin";
import { cn } from "@/lib/utils";
import { markBookingSeenAction, startBookingEnquiryThreadAction } from "../actions";
import { RescheduleControls } from "./booking-controls";
import { NoteForm } from "./note-form";
import { StatusControls } from "./status-controls";

export const metadata: Metadata = { title: "Booking" };

const NOTICES: Record<string, { tone: "error" | "success"; text: string }> = {
  created: { tone: "success", text: "Booking made. The customer gets their confirmation now." },
  account_not_set: { tone: "error", text: "Booking made, but it could not be charged to the account. Check the account and PO number." },
  ...Object.fromEntries(Object.entries(CHANGE_MESSAGES).map(([code, text]) => [code, { tone: "error" as const, text }])),
};

const KIND_ICONS: Record<TimelineKind, typeof History> = {
  created: CalendarClock,
  status: Check,
  cancelled: X,
  moved: CalendarClock,
  note: StickyNote,
  message: MessageSquare,
  other: History,
};

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[12px] font-bold tracking-[0.06em] text-grey-600 uppercase">{label}</dt>
      <dd className="m-0 text-[15px] text-grey-800">{children}</dd>
    </div>
  );
}

/**
 * One booking: status changes (requested → confirmed → arrived → in bay ⇄ waiting parts → ready →
 * collected; cancel; no-show), moving it, notes and the booking_events timeline. Reads and status
 * writes go through the garage's RLS client; another garage's booking is "not found".
 */
export default async function BookingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string }> }) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  const timeZone = admin.garage.timezone || "Europe/London";

  let booking;
  let opening = new Map<number, unknown[]>();
  try {
    [booking, opening] = await Promise.all([loadBookingDetail(admin.client, id), loadOpeningHours(admin.client)]);
  } catch (error) {
    if (!(error instanceof AdminDataError)) throw error;
    booking = undefined;
  }
  if (booking === null) notFound();

  const notice = NOTICES[(await searchParams).notice ?? ""] ?? null;
  if (!booking) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="Booking" />
        <div role="alert" className="rounded-card border border-[#f3c4c4] bg-[#fdecec] px-4 py-3.5 text-[14px] font-semibold text-[#991b1b]">
          This booking could not be loaded. Refresh the page to try again.
        </div>
      </div>
    );
  }

  // P5.7: the fleet or trade account (and PO) the booking is charged to, if any.
  const account = await getBookingAccount(admin.client, admin.garage.id, booking.id);
  const tel = telLink(booking.customerPhone);
  const car = vehicleName(booking);
  const today = localDateKey(new Date(), timeZone);
  const moveDays = Array.from({ length: 21 }, (_, index) => addDays(today, index));
  const closedDays = opening.size > 0 ? moveDays.filter((day) => !(opening.get(isoWeekday(day)) ?? []).length) : [];
  const movable = booking.status === "requested" || booking.status === "confirmed";
  const timeline = booking.events.map((event) => timelineEntry(event, { currentUserId: admin.user.id, timeZone }));

  return (
    <div className="flex flex-col gap-[18px]">
      <MarkBookingSeen bookingId={booking.id} action={markBookingSeenAction} />
      <Link href="/app/bookings" className={cn(textLinkClass, "-mb-2 hidden gap-1.5 self-start text-[14px] lg:inline-flex")}>
        <ArrowLeft size={18} strokeWidth={2} aria-hidden="true" />
        All bookings
      </Link>
      <PageHeader
        eyebrow={booking.reference}
        title={booking.customerName}
        description={`${booking.serviceName} · ${formatSlotLabel(booking.startsAt, timeZone)} to ${formatTime(booking.endsAt, timeZone)}`}
        actions={
          <div className="flex flex-wrap items-center gap-2.5">
            <StatusPill status={booking.status} />
            <form action={startBookingEnquiryThreadAction}>
              <input type="hidden" name="bookingId" value={booking.id} />
              <BookingEmailThreadButton label={`Email ${booking.customerName} about booking ${booking.reference}`} showLabel />
            </form>
          </div>
        }
      />

      {notice ? (
        <div
          role={notice.tone === "error" ? "alert" : "status"}
          className={cn(
            "rounded-card px-4 py-3.5 text-[14px] font-semibold",
            notice.tone === "error" ? "border border-[#f3c4c4] bg-[#fdecec] text-[#991b1b]" : "border border-[#bfe5cb] bg-success-bg text-success-ink",
          )}
        >
          {notice.text}
        </div>
      ) : null}

      <div className="flex flex-wrap items-start gap-[18px]">
        <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-[18px]">
          <Panel id="status" title="Status">
            <StatusControls bookingId={booking.id} status={booking.status} reference={booking.reference} />
          </Panel>

          <Panel id="job" title="The job">
            <dl className="m-0 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <Fact label="Service">{booking.serviceName}</Fact>
              <Fact label="When">
                {formatSlotLabel(booking.startsAt, timeZone)}
                <span className="text-grey-600"> to {formatTime(booking.endsAt, timeZone)}</span>
              </Fact>
              <Fact label={booking.locationMode === "mobile" ? "Where" : "Bay"}>
                {booking.locationMode === "mobile"
                  ? [booking.address, booking.postcode].filter(Boolean).join(", ") || "Mobile visit"
                  : (booking.resourceName ?? "Not assigned")}
              </Fact>
              <Fact label="Price">{booking.pricePence === null ? "Quote" : formatServicePrice(booking.pricePence, "fixed")}</Fact>
              <Fact label="Booked">
                {SOURCE_LABELS[booking.source]}, {formatSlotLabel(booking.createdAt, timeZone)}
              </Fact>
              {booking.status === "cancelled" && booking.cancellationReason ? <Fact label="Cancelled">{booking.cancellationReason}</Fact> : null}
              {account ? (
                <Fact label="Account">
                  <Link href={`/app/accounts/${account.accountId}`} className={textLinkClass}>{account.name}</Link>
                  <span className="block text-grey-600">{account.poNumber ? `PO ${account.poNumber}` : "No PO number"}</span>
                </Fact>
              ) : null}
            </dl>
            {booking.symptoms.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <h3 className="m-0 font-sans text-[12px] font-bold tracking-[0.06em] text-grey-600 uppercase">What they said</h3>
                <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                  {booking.symptoms.map((symptom) => (
                    <li key={symptom} className="rounded-full bg-grey-100 px-3 py-1.5 text-[13px] font-semibold text-grey-700">
                      {symptom}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <h3 className="m-0 font-sans text-[12px] font-bold tracking-[0.06em] text-grey-600 uppercase">Customer&apos;s note</h3>
              <p className="m-0 text-[15px] leading-normal whitespace-pre-wrap text-grey-800">{booking.notes ?? "No note."}</p>
            </div>
          </Panel>

          <Panel id="move" title="Move this booking">
            {movable ? (
              <RescheduleControls bookingId={booking.id} currentStart={booking.startsAt} timeZone={timeZone} days={moveDays} closedDays={closedDays} />
            ) : (
              <p className="m-0 text-[14px] text-grey-600">
                Only bookings that are waiting for your OK or booked can be moved. This one is {booking.status === "cancelled" ? "cancelled" : "under way or finished"}.
              </p>
            )}
            <p className="m-0 text-[13px] text-grey-600">Dragging bookings on the diary is coming; for now, move a booking here.</p>
          </Panel>
        </div>

        <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-[18px]">
          <Panel id="customer" title="Customer and car">
            <div className="flex flex-col gap-1">
              <p className="m-0 text-[16px] font-bold text-navy-950">{booking.customerName}</p>
              {tel ? (
                <a href={tel} className={cn(textLinkClass, "gap-2 self-start text-[15px]")}>
                  <Phone size={18} strokeWidth={2} aria-hidden="true" />
                  {formatUkPhone(booking.customerPhone)}
                </a>
              ) : null}
              {booking.customerEmail ? (
                <a href={`mailto:${booking.customerEmail}`} className={cn(textLinkClass, "gap-2 self-start text-[15px] break-all")}>
                  <Mail size={18} strokeWidth={2} aria-hidden="true" />
                  {booking.customerEmail}
                </a>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2.5 border-t border-[#eef2f6] pt-3.5">
              {booking.registration ? <PlateChip registration={booking.registration} size="md" /> : null}
              <span className="text-[15px] text-grey-700">{car ?? "Car details not recorded"}</span>
            </div>
          </Panel>

          <Panel id="history" title="History">
            <NoteForm bookingId={booking.id} />
            {timeline.length > 0 ? (
              <ol className="m-0 flex list-none flex-col p-0" aria-label="Booking history, newest first">
                {timeline.map((entry) => {
                  const Icon = KIND_ICONS[entry.kind];
                  return (
                    <li key={entry.id} className="flex gap-3 border-t border-[#eef2f6] py-3 first:border-t-0">
                      <span
                        aria-hidden="true"
                        className={cn(
                          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full",
                          entry.kind === "cancelled" ? "bg-[#fdecec] text-[#991b1b]" : entry.kind === "note" ? "bg-warning-bg text-warning-ink" : "bg-grey-100 text-grey-700",
                        )}
                      >
                        <Icon size={16} strokeWidth={2} />
                      </span>
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <p className="m-0 text-[14px] font-bold text-navy-950">{entry.title}</p>
                        {entry.detail ? <p className="m-0 text-[14px] leading-normal whitespace-pre-wrap text-grey-800">{entry.detail}</p> : null}
                        <p className="m-0 text-[12.5px] text-grey-600">
                          {entry.actor} · <time dateTime={entry.at}>{formatSlotLabel(entry.at, timeZone)}</time>
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="m-0 text-[14px] text-grey-600">Nothing has happened to this booking yet.</p>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

