import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { focusRing } from "@/components/book/styles";
import { fillGarageName, UNSUBSCRIBE_COPY } from "@/lib/consent/copy";
import { verifyUnsubscribeToken } from "@/lib/consent/unsubscribe-token";
import { requireSiteGarage } from "@/lib/tenancy/garage";
import { cn } from "@/lib/utils";
import { BookingScreen } from "../../../_components/booking-screen";

export const metadata: Metadata = {
  title: "Reminders back on",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

type ResumedPageProps = { params: Promise<{ garageId: string; token: string }> };

/** After "Turn reminders back on". Reading only: the change was made by the form's server action. */
export default async function ResumedPage({ params }: ResumedPageProps) {
  const { garageId, token } = await params;
  const garage = await requireSiteGarage(garageId);
  if (!verifyUnsubscribeToken(garage.id, token)) redirect("/unsubscribe");

  return (
    <BookingScreen garage={garage} subtitle="Reminders" withActionBar={false}>
      <div className="flex flex-col gap-4 px-5 pt-5 pb-10">
        <h1 className="m-0 font-display text-[34px] leading-[0.98] font-extrabold text-navy-950">Reminders are back on</h1>
        <p role="status" className="m-0 text-[15px] leading-normal text-grey-700">{fillGarageName(UNSUBSCRIBE_COPY.resumed, garage.name)}</p>
        <Link href={`/unsubscribe/${token}`} className={cn("text-[15px] font-bold text-navy-950 underline underline-offset-2", focusRing)}>
          Stop reminders again
        </Link>
      </div>
    </BookingScreen>
  );
}
