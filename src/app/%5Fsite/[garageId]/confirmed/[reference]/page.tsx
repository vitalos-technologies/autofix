import type { Metadata } from "next";
import Link from "next/link";
import { Check, Search } from "lucide-react";
import { ConfirmationCard, GarageHeader, formatRegistrationDisplay, formatSlotLabel } from "@/components/book";
import { focusRing } from "@/components/book/styles";
import { readJustBooked, type JustBooked } from "@/lib/booking-engine/state";
import { lastDigits } from "@/lib/booking-flow/copy";
import { bookingCalendarPath } from "@/lib/booking-flow/server";
import { whatsappHref } from "@/lib/tenancy/contact";
import { requireSiteGarage } from "@/lib/tenancy/garage";
import { cn } from "@/lib/utils";
import { BOOKING_COLUMN, BookingScreen } from "../../_components/booking-screen";
import { PoweredByPitline } from "@/components/brand/powered-by";
import { manageTextLink } from "../../_components/manage-ui";

export const metadata: Metadata = {
  title: "Booking confirmed",
  robots: { index: false, follow: false, nocache: true },
};

type ConfirmedPageProps = { params: Promise<{ garageId: string; reference: string }> };

function decodeReference(raw: string) {
  try {
    return decodeURIComponent(raw).trim().slice(0, 40);
  } catch {
    return "";
  }
}

function SentTo({ booked }: { booked: JustBooked }) {
  const hint = <span aria-hidden="true">{booked.contactHint}</span>;
  const spoken =
    booked.channel === "email" ? <span className="sr-only">your email address</span> : <span className="sr-only">your mobile ending {lastDigits(booked.contactHint)}</span>;
  const target = (
    <>
      {hint}
      {spoken}
    </>
  );
  if (booked.channel === "email") return <>We&apos;ll email your confirmation to {target}.</>;
  if (booked.channel === "whatsapp") return <>We&apos;ll send your confirmation on WhatsApp to {target}.</>;
  return <>We&apos;ll text your confirmation to {target}.</>;
}

/**
 * Book 5 · Confirmed. Shows the booking only to the browser that just made it (sealed `af_booked`
 * cookie for this garage and reference); the reference in the address reveals nothing by itself.
 * A white page with navy text (Temitope, 29 Oct 2026); the garage accent stays on the buttons.
 */
export default async function ConfirmedPage({ params }: ConfirmedPageProps) {
  const { garageId, reference: rawReference } = await params;
  const garage = await requireSiteGarage(garageId);
  const reference = decodeReference(rawReference);
  const booked = reference ? await readJustBooked(garage.id, reference) : null;

  if (!booked) {
    return (
      <BookingScreen garage={garage} subtitle={null} withActionBar={false}>
        <div className="flex flex-col gap-3 px-5 pt-7 pb-10">
          <h1 className="m-0 font-display text-[36px] leading-[0.98] font-extrabold text-navy-950">Find your booking</h1>
          <p className="m-0 text-[15px] leading-normal text-grey-600">
            For your privacy, booking details only show here straight after booking, on the same device. Your confirmation message has
            everything you need, or you can look the booking up with its reference and your registration.
          </p>
          <Link
            href="/manage"
            className="mt-3 inline-flex h-[54px] items-center justify-center gap-2 rounded-control bg-accent px-4 text-[16px] font-bold text-accent-ink no-underline hover:bg-[color-mix(in_srgb,var(--garage-accent)_88%,black)]"
          >
            <Search size={18} strokeWidth={2} aria-hidden="true" />
            Find your booking
          </Link>
          <Link href="/" className="inline-flex min-h-11 items-center justify-center text-[14px] font-semibold text-accent-text underline underline-offset-2">
            Book a car in
          </Link>
        </div>
      </BookingScreen>
    );
  }

  const requested = booked.status === "requested";
  const whatsapp = whatsappHref(garage.whatsapp);
  const car = [booked.vehicleName, formatRegistrationDisplay(booked.registration)].filter(Boolean).join(" · ");

  return (
    <div className="flex min-h-dvh flex-col bg-white font-sans text-grey-800">
      <div className={cn(BOOKING_COLUMN, "flex grow flex-col")}>
        <GarageHeader tone="light" name={garage.name} logoUrl={garage.logoUrl} phone={garage.phone} contactHref="/contact" />
        <div className="flex flex-col items-center gap-[22px] px-6 pt-9 text-center">
          <span
            aria-hidden="true"
            className="flex size-[84px] items-center justify-center rounded-full bg-success text-white outline-[10px] outline-[rgba(22,163,74,0.18)] outline-solid"
          >
            <Check size={40} strokeWidth={3} />
          </span>
          <div className="flex flex-col gap-2">
            <h1 className="m-0 font-display text-[44px] leading-[0.95] font-extrabold text-navy-950">{requested ? "Request sent" : "You're booked in"}</h1>
            <p className="m-0 text-[15px] leading-normal text-grey-600">
              {requested ? `${garage.name} will check the job and confirm the time with you. ` : null}
              <SentTo booked={booked} />
            </p>
          </div>
          <ConfirmationCard
            reference={booked.reference}
            when={formatSlotLabel(booked.startsAt, garage.timezone)}
            vehicle={car}
            service={booked.serviceName}
            location={booked.where}
            calendarHref={requested ? null : bookingCalendarPath(garage, booked.reference)}
            manageHref="/manage"
          />
          {booked.extras?.length ? (
            <ul aria-label="Extras" className="m-0 flex w-full list-none flex-col gap-2 p-0 text-left">
              {booked.extras.map((line) => (
                <li key={line} className="rounded-[12px] border border-grey-200 bg-grey-50 px-4 py-3 text-[14px] leading-normal text-grey-800">
                  {line}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="mt-auto flex flex-col items-center gap-3.5 px-6 pt-10 pb-7">
          {whatsapp ? (
            <a
              href={whatsapp}
              rel="noopener noreferrer"
              className={cn(
                "flex h-[50px] w-full items-center justify-center rounded-control bg-[#15803d] px-3 text-[14.5px] font-bold text-white no-underline transition-colors hover:bg-success-ink",
                focusRing,
              )}
            >
              Message the garage on WhatsApp
            </a>
          ) : null}
          <Link href="/" className={manageTextLink}>
            Book another car
          </Link>
          <PoweredByPitline className="text-[11.5px]" />
        </div>
      </div>
    </div>
  );
}
