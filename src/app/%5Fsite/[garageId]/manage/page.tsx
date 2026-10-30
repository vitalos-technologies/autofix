import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { CalendarClock, CalendarPlus, CircleCheck, CircleX, Clock, Hourglass, Info, MessageCircle, Phone, Wrench } from "lucide-react";
import { BookingStatusChip, formatSlotLabel } from "@/components/book";
import { postcodeDistrict } from "@/lib/booking-flow/copy";
import { forgetManagedBookingAction } from "@/lib/booking-flow/manage-actions";
import { readManagedBooking, toManageBookingView } from "@/lib/booking-flow/manage-server";
import {
  canChangeOnline,
  cutoffWindow,
  MANAGE_DONE,
  MANAGE_LINK_PROBLEMS,
  manageStatusChip,
  oneOf,
  type ManageBookingView,
  type ManageDone,
  type ManageLinkProblem,
} from "@/lib/booking-flow/manage-view";
import { bookingCalendarPath, humanCheckConfigured } from "@/lib/booking-flow/server";
import { addressLine, formatPhoneForDisplay, telHref, whatsappHref } from "@/lib/tenancy/contact";
import { requireSiteGarage, type Garage } from "@/lib/tenancy/garage";
import { cn } from "@/lib/utils";
import { BookingScreen, BookingUnavailable } from "../_components/booking-screen";
import { ManageLookup } from "../_components/manage-lookup";
import {
  ManageBookingCard,
  ManageNotice,
  managePrimaryAction,
  manageSecondaryAction,
  manageTextLink,
  manageWhatsappAction,
} from "../_components/manage-ui";
import { PoweredByPitline } from "@/components/brand/powered-by";

export const metadata: Metadata = {
  title: "Manage your booking",
  robots: { index: false, follow: false, nocache: true },
};

type ManagePageProps = {
  params: Promise<{ garageId: string }>;
  /**
   * `?token=` (the signed email link, handed straight to `/manage/link`), `?link=` (that link did not
   * open a booking) and `?done=` (after a change). None of them is personal data.
   */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const SUBTITLE = "Manage your booking";
const iconProps = { size: 20, strokeWidth: 2 } as const;

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function lookupNotice(session: "none" | "expired" | "missing", link: ManageLinkProblem | null) {
  if (link === "invalid") {
    return (
      <ManageNotice tone="warning" icon={<Info {...iconProps} />} title="That link didn't open a booking">
        It may have expired, or the booking may have been changed. Find your booking with its reference and registration instead.
      </ManageNotice>
    );
  }
  if (link === "limited") {
    return (
      <ManageNotice tone="warning" icon={<Info {...iconProps} />} title="Too many attempts">
        Please wait a few minutes and try the link again, or find your booking below.
      </ManageNotice>
    );
  }
  if (link === "unavailable") {
    return (
      <ManageNotice tone="warning" icon={<Info {...iconProps} />} title="We couldn't open your booking just now">
        Please try the link again in a moment, or find your booking below.
      </ManageNotice>
    );
  }
  if (session !== "none") {
    return (
      <ManageNotice tone="info" icon={<Clock {...iconProps} />}>
        For your security, your booking closes after 30 minutes. Find it again to carry on.
      </ManageNotice>
    );
  }
  return null;
}

function whereFor(view: ManageBookingView, garage: Garage, postcode: string | null) {
  if (view.locationMode === "mobile") {
    const district = postcodeDistrict(postcode);
    return { where: "Mobile visit", detail: district ? `At your address in ${district}` : null };
  }
  return { where: "Workshop", detail: addressLine(garage.address) || null };
}

function ContactActions({ garage, primary = false }: { garage: Garage; primary?: boolean }) {
  const tel = telHref(garage.phone);
  const whatsapp = whatsappHref(garage.whatsapp);
  if (!tel && !whatsapp) return null;
  // On a phone the half-width button only fits "Call the garage"; the primary one shows the number.
  const call = tel ? (
    <a href={tel} className={primary ? managePrimaryAction : manageSecondaryAction}>
      <Phone size={18} strokeWidth={2} aria-hidden="true" className="shrink-0" />
      {primary ? `Call ${formatPhoneForDisplay(garage.phone)}` : "Call the garage"}
    </a>
  ) : null;
  const message = whatsapp ? (
    <a href={whatsapp} rel="noopener noreferrer" className={manageWhatsappAction}>
      <MessageCircle size={18} strokeWidth={2} aria-hidden="true" className="shrink-0" />
      WhatsApp
    </a>
  ) : null;
  if (primary) {
    return (
      <div className="flex flex-col gap-2.5">
        {call}
        {message}
      </div>
    );
  }
  return <div className={cn("grid gap-2.5", call && message ? "grid-cols-2" : "grid-cols-1")}>{call}{message}</div>;
}

function StateNotice({ view, garage, done }: { view: ManageBookingView; garage: Garage; done: ManageDone | null }) {
  switch (view.state) {
    case "requested":
      return (
        <ManageNotice tone="warning" icon={<Hourglass {...iconProps} />} title="Not confirmed yet">
          {garage.name} will check the job and confirm the time with you.
        </ManageNotice>
      );
    case "cutoff":
      return (
        <ManageNotice tone="info" icon={<Phone {...iconProps} />} title="Too close to change online">
          Bookings can&apos;t be changed online in the last {cutoffWindow(garage.cancellationCutoffH)} before they start. Call {garage.name} to
          change or cancel.
        </ManageNotice>
      );
    case "in_workshop":
      return (
        <ManageNotice tone="info" icon={<Wrench {...iconProps} />} title={`Your car is with ${garage.name}`}>
          Call them for an update, or if anything needs to change.
        </ManageNotice>
      );
    case "past":
      return (
        <ManageNotice tone="neutral" icon={<Clock {...iconProps} />} title="This booking's time has passed">
          Need the car looked at again? Book a new time below.
        </ManageNotice>
      );
    case "finished":
      return (
        <ManageNotice tone="neutral" icon={<CircleCheck {...iconProps} />} title="This booking is finished">
          Thanks for choosing {garage.name}. Book again whenever the car needs it.
        </ManageNotice>
      );
    case "no_show":
      return (
        <ManageNotice tone="neutral" icon={<CircleX {...iconProps} />} title="This booking was missed">
          Book a new time below, or call {garage.name}.
        </ManageNotice>
      );
    case "cancelled":
      // Straight after cancelling, the success message says it all.
      return done === "cancelled" ? null : (
        <ManageNotice tone="neutral" icon={<CircleX {...iconProps} />} title="This booking was cancelled">
          Book a new time whenever you&apos;re ready.
        </ManageNotice>
      );
    default:
      return null;
  }
}

function DoneNotice({ done, view, timeZone }: { done: ManageDone | null; view: ManageBookingView; timeZone: string }) {
  if (done === "moved" && view.state !== "cancelled") {
    return (
      <ManageNotice live tone="success" icon={<CircleCheck {...iconProps} />} title="Your booking has moved">
        It&apos;s now on {formatSlotLabel(view.startsAt, timeZone)}. We&apos;ll send you the new time.
      </ManageNotice>
    );
  }
  if (done === "cancelled" && view.state === "cancelled") {
    return (
      <ManageNotice live tone="success" icon={<CircleCheck {...iconProps} />} title="Your booking is cancelled">
        The time has been freed up. You can book again whenever you&apos;re ready.
      </ManageNotice>
    );
  }
  return null;
}

/**
 * Manage booking on the garage host. Without a session: the reference + registration form. With
 * one (from that form or the signed email link): the booking, its status and what can be done.
 */
export default async function ManagePage({ params, searchParams }: ManagePageProps) {
  const garage = await requireSiteGarage((await params).garageId);
  const query = await searchParams;

  // The signed link from an email: `/manage/link` opens the session and drops the token from the address.
  const token = single(query.token);
  if (token !== undefined) redirect(`/manage/link?token=${encodeURIComponent(token)}`);

  const session = await readManagedBooking(garage.id);
  if (session.kind === "unavailable") {
    return (
      <BookingScreen garage={garage} subtitle={SUBTITLE} withActionBar={false}>
        <BookingUnavailable garage={garage} title="We can't open your booking right now" />
      </BookingScreen>
    );
  }
  if (session.kind !== "open") {
    const notice = lookupNotice(session.kind, oneOf(MANAGE_LINK_PROBLEMS, single(query.link)));
    return (
      <BookingScreen garage={garage} subtitle={SUBTITLE}>
        <ManageLookup bookingPrefix={garage.bookingPrefix} notice={notice} humanCheck={humanCheckConfigured()} />
      </BookingScreen>
    );
  }

  const booking = session.booking;
  const view = toManageBookingView(booking);
  const timeZone = garage.timezone;
  const done = oneOf(MANAGE_DONE, single(query.done));
  const chip = manageStatusChip(view);
  const changeable = canChangeOnline(view.state);
  const closed = view.state === "cancelled" || view.state === "past" || view.state === "finished" || view.state === "no_show";
  const calendarHref = view.status === "confirmed" && (view.state === "open" || view.state === "cutoff") ? bookingCalendarPath(garage, view.reference) : null;
  const { where, detail } = whereFor(view, garage, booking.postcode);

  let actions: ReactNode;
  if (changeable) {
    actions = (
      <>
        <Link href="/manage/reschedule" className={managePrimaryAction}>
          <CalendarClock size={18} strokeWidth={2} aria-hidden="true" className="shrink-0" />
          Change the time
        </Link>
        <Link href="/manage/cancel" className={cn(manageSecondaryAction, "text-[#b91c1c] hover:border-[#b91c1c]")}>
          Cancel booking
        </Link>
        <p className="m-0 text-center text-[13px] text-grey-600">Free to change or cancel online until {formatSlotLabel(view.changeDeadline, timeZone)}.</p>
        {calendarHref ? (
          <a href={calendarHref} className={manageSecondaryAction}>
            <CalendarPlus size={18} strokeWidth={2} aria-hidden="true" className="shrink-0" />
            Add to calendar
          </a>
        ) : null}
        <ContactActions garage={garage} />
      </>
    );
  } else if (closed) {
    actions = (
      <>
        <Link href="/" className={managePrimaryAction}>
          Book a car in
        </Link>
        <ContactActions garage={garage} />
      </>
    );
  } else {
    actions = (
      <>
        <ContactActions garage={garage} primary />
        {calendarHref ? (
          <a href={calendarHref} className={manageSecondaryAction}>
            <CalendarPlus size={18} strokeWidth={2} aria-hidden="true" className="shrink-0" />
            Add to calendar
          </a>
        ) : null}
      </>
    );
  }

  return (
    <BookingScreen garage={garage} subtitle={SUBTITLE} withActionBar={false}>
      <div className="flex flex-col gap-[18px] px-5 pt-[22px] pb-8">
        <DoneNotice done={done} view={view} timeZone={timeZone} />
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2.5">
          <h1 className="m-0 font-display text-[36px] leading-[0.98] font-extrabold text-navy-950">Your booking</h1>
          <BookingStatusChip label={chip.label} tone={chip.tone} />
        </div>
        <ManageBookingCard view={view} timeZone={timeZone} where={where} whereDetail={detail} />
        <StateNotice view={view} garage={garage} done={done} />
        <div className="flex flex-col gap-2.5">{actions}</div>
        <div className="flex flex-col items-center gap-1 pt-2">
          <form action={forgetManagedBookingAction}>
            <button type="submit" className={manageTextLink}>
              Look up another booking
            </button>
          </form>
          <PoweredByPitline />
        </div>
      </div>
    </BookingScreen>
  );
}
