import type { Metadata } from "next";
import { fillGarageName, UNSUBSCRIBE_COPY } from "@/lib/consent/copy";
import { requireSiteGarage } from "@/lib/tenancy/garage";
import { BookingScreen } from "../_components/booking-screen";
import { UnsubscribeForm } from "../_components/unsubscribe-form";

export const metadata: Metadata = {
  title: "Stop reminders",
  robots: { index: false, follow: false, nocache: true },
};

type UnsubscribePageProps = { params: Promise<{ garageId: string }> };

/** Stop reminders without a link: the customer gives the mobile number we text. */
export default async function UnsubscribePage({ params }: UnsubscribePageProps) {
  const garage = await requireSiteGarage((await params).garageId);
  return (
    <BookingScreen garage={garage} back={{ href: "/", label: "Back to booking" }} subtitle="Reminders" withActionBar={false}>
      <div className="flex flex-col gap-4 px-5 pt-5 pb-10">
        <h1 className="m-0 font-display text-[34px] leading-[0.98] font-extrabold text-navy-950">Stop reminders</h1>
        <p className="m-0 text-[15px] leading-normal text-grey-700">{fillGarageName(UNSUBSCRIBE_COPY.formPrompt, garage.name)}</p>
        <UnsubscribeForm doneMessage={fillGarageName(UNSUBSCRIBE_COPY.formResponse, garage.name)} />
      </div>
    </BookingScreen>
  );
}
