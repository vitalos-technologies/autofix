import type { Metadata } from "next";
import Link from "next/link";
import { Phone } from "lucide-react";
import { reminderLinkProblem, type ReminderLinkProblem } from "@/lib/reminders/link-problems";
import { formatPhoneForDisplay, telHref } from "@/lib/tenancy/contact";
import { requireSiteGarage } from "@/lib/tenancy/garage";
import { BookingScreen } from "../_components/booking-screen";
import { managePrimaryAction, manageSecondaryAction } from "../_components/manage-ui";

// Where a reminder link (`/r/{token}`) that opens nothing lands: `/r?link=expired|invalid|limited|unavailable`.
// The query names the problem only; the token is never in this address.

export const metadata: Metadata = {
  title: "Book online",
  robots: { index: false, follow: false, nocache: true },
};

const COPY: Record<ReminderLinkProblem, { title: string; body: string }> = {
  expired: {
    title: "This link has expired",
    body: "Reminder links work for 30 days. You can still book online in about a minute.",
  },
  invalid: {
    title: "This link isn't working",
    body: "It may have been copied only in part. You can still book online in about a minute.",
  },
  limited: {
    title: "Too many attempts",
    body: "Please wait a few minutes and try the link again, or book online now.",
  },
  unavailable: {
    title: "We couldn't open your link",
    body: "Please try the link again in a moment, or book online now.",
  },
};

type ReminderLinkPageProps = {
  params: Promise<{ garageId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ReminderLinkPage({ params, searchParams }: ReminderLinkPageProps) {
  const garage = await requireSiteGarage((await params).garageId);
  const copy = COPY[reminderLinkProblem((await searchParams).link)];
  const tel = telHref(garage.phone);

  return (
    <BookingScreen garage={garage} subtitle="Book online" withActionBar={false}>
      <div className="flex flex-col gap-3 px-5 pt-5 pb-8">
        <h1 className="m-0 font-display text-[34px] leading-[0.98] font-extrabold text-navy-950">{copy.title}</h1>
        <p className="m-0 text-[15px] leading-normal text-grey-600">{copy.body}</p>
        <div className="mt-2 flex flex-col gap-2.5">
          <Link href="/" className={managePrimaryAction}>
            Book online
          </Link>
          {tel ? (
            <a href={tel} className={manageSecondaryAction}>
              <Phone size={18} strokeWidth={2} aria-hidden="true" className="shrink-0" />
              Call {formatPhoneForDisplay(garage.phone)}
            </a>
          ) : null}
        </div>
      </div>
    </BookingScreen>
  );
}
