import type { Metadata } from "next";
import Link from "next/link";
import { Check } from "lucide-react";
import { focusRing } from "@/components/book/styles";
import { loadPublicPlans, signupReadiness } from "@/lib/service-plans/server";
import { monthlyPrice, planBenefitLines } from "@/lib/service-plans/view";
import { requireSiteGarage } from "@/lib/tenancy/garage";
import { cn } from "@/lib/utils";
import { BookingScreen } from "../_components/booking-screen";

export const metadata: Metadata = { title: "Service plans", description: "Monthly service plans paid by Direct Debit." };

/**
 * Service plans (P5.11) on the garage host: the garage's active plans and a "Join" link for each.
 * Only for Pro garages with plans and payments set up; anyone else sees "not available".
 */
export default async function PlansPage({ params }: { params: Promise<{ garageId: string }> }) {
  const garage = await requireSiteGarage((await params).garageId);
  const [plans, ready] = await Promise.all([loadPublicPlans(garage), signupReadiness(garage)]);
  const open = ready.ok && plans.length > 0;

  return (
    <BookingScreen garage={garage} subtitle="Service plans" withActionBar={false}>
      <div className="flex flex-col gap-4 px-5 pt-7 pb-8">
        <h1 className="m-0 font-display text-[34px] leading-[0.98] font-extrabold text-navy-950">{open ? "Look after your car for a monthly fee" : "Service plans aren't available"}</h1>
        {open ? (
          <>
            <p className="m-0 text-[15px] leading-normal text-grey-700">
              Spread the cost of keeping your car on the road. Pay monthly by Direct Debit and cancel any time.
            </p>
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {plans.map((plan) => (
                <li key={plan.id} className="flex flex-col gap-3 rounded-card border border-grey-200 bg-white p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="m-0 font-sans text-[19px] font-bold text-navy-950">{plan.name}</h2>
                    <p className="m-0 font-display text-[24px] leading-none font-extrabold text-navy-950">{monthlyPrice(plan.pricePence)}</p>
                  </div>
                  {plan.description ? <p className="m-0 text-[14px] leading-normal text-grey-700">{plan.description}</p> : null}
                  <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                    {planBenefitLines(plan).map((line) => (
                      <li key={line} className="flex items-start gap-2 text-[14.5px] leading-normal text-grey-800">
                        <Check size={17} strokeWidth={2.4} aria-hidden="true" className="mt-0.5 shrink-0 text-success-ink" />
                        {line}
                      </li>
                    ))}
                  </ul>
                  <Link
                    href={`/plans/${plan.id}`}
                    className={cn("inline-flex h-[50px] items-center justify-center rounded-control bg-accent px-4 text-[16px] font-bold text-accent-ink no-underline", focusRing)}
                  >
                    Join {plan.name}
                  </Link>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="m-0 text-[15px] leading-normal text-grey-700">{garage.name} doesn&apos;t offer service plans online right now. You can still book your car in.</p>
        )}
        <Link href="/" className="inline-flex min-h-11 items-center justify-center text-[14px] font-semibold text-accent underline underline-offset-2">
          Book a job instead
        </Link>
      </div>
    </BookingScreen>
  );
}
