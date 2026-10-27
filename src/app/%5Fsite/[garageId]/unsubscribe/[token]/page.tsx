import type { Metadata } from "next";
import Link from "next/link";
import { focusRing } from "@/components/book/styles";
import { resumeRemindersAction } from "@/lib/consent/actions";
import { fillGarageName, UNSUBSCRIBE_COPY } from "@/lib/consent/copy";
import { optOutWithToken } from "@/lib/consent/unsubscribe";
import { requireSiteGarage } from "@/lib/tenancy/garage";
import { cn } from "@/lib/utils";
import { BookingScreen, FormAlert } from "../../_components/booking-screen";

export const metadata: Metadata = {
  title: "Reminders stopped",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

type UnsubscribeLinkPageProps = {
  params: Promise<{ garageId: string; token: string }>;
  searchParams: Promise<{ retry?: string }>;
};

/**
 * The signed link from a message: opening it opts the customer out of this
 * garage's reminders straight away (idempotent; audited for the garage).
 */
export default async function UnsubscribeLinkPage({ params, searchParams }: UnsubscribeLinkPageProps) {
  const { garageId, token } = await params;
  const garage = await requireSiteGarage(garageId);
  const { retry } = await searchParams;
  const result = await optOutWithToken(garage, token);

  return (
    <BookingScreen garage={garage} subtitle="Reminders" withActionBar={false}>
      <div className="flex flex-col gap-4 px-5 pt-5 pb-10">
        {result.status === "done" ? (
          <>
            <h1 className="m-0 font-display text-[34px] leading-[0.98] font-extrabold text-navy-950">Reminders stopped</h1>
            <p className="m-0 text-[15px] leading-normal text-grey-700">{fillGarageName(UNSUBSCRIBE_COPY.done, garage.name)}</p>
            {retry ? <FormAlert>We couldn&apos;t turn reminders back on just now. Please try again.</FormAlert> : null}
            <form action={resumeRemindersAction} className="flex flex-col gap-2.5 rounded-control border border-grey-200 bg-white px-3.5 py-3">
              <input type="hidden" name="token" value={token} />
              <p className="m-0 text-[15px] font-semibold text-navy-950">{UNSUBSCRIBE_COPY.changedMind}</p>
              <button
                type="submit"
                className={cn(
                  "inline-flex h-[48px] w-full cursor-pointer items-center justify-center rounded-control border border-accent bg-white px-4 text-[15px] font-bold text-navy-950",
                  focusRing,
                )}
              >
                {UNSUBSCRIBE_COPY.resumeLabel}
              </button>
            </form>
          </>
        ) : result.status === "invalid_link" ? (
          <>
            <h1 className="m-0 font-display text-[34px] leading-[0.98] font-extrabold text-navy-950">This link doesn&apos;t work</h1>
            <p className="m-0 text-[15px] leading-normal text-grey-700">
              It may have been copied incompletely. You can still stop reminders with your mobile number.
            </p>
            <Link href="/unsubscribe" className={cn("text-[15px] font-bold text-navy-950 underline underline-offset-2", focusRing)}>
              Stop reminders with your mobile number
            </Link>
          </>
        ) : (
          <>
            <h1 className="m-0 font-display text-[34px] leading-[0.98] font-extrabold text-navy-950">Please try again</h1>
            <FormAlert>We couldn&apos;t stop reminders just now. Please reload this page in a minute, or reply STOP to any reminder text.</FormAlert>
          </>
        )}
      </div>
    </BookingScreen>
  );
}
