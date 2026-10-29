import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Check } from "lucide-react";
import { humanCheckConfigured } from "@/lib/booking-flow/server";
import { getPaymentsProvider } from "@/lib/payments";
import { loadPublicPlans, signupReadiness } from "@/lib/service-plans/server";
import { guaranteeParagraphs, monthlyPrice, planBenefitLines } from "@/lib/service-plans/view";
import { requireSiteGarage } from "@/lib/tenancy/garage";
import { BookingScreen } from "../../_components/booking-screen";
import { PlanSignupForm } from "./signup-form";

export const metadata: Metadata = { title: "Join a service plan", robots: { index: false, follow: false } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Join one plan (P5.11): the plan, the form, the Direct Debit Guarantee. 404 for anything not on offer. */
export default async function JoinPlanPage({ params }: { params: Promise<{ garageId: string; planId: string }> }) {
  const { garageId, planId } = await params;
  const garage = await requireSiteGarage(garageId);
  if (!UUID.test(planId)) notFound();
  const [plans, ready] = await Promise.all([loadPublicPlans(garage), signupReadiness(garage)]);
  const plan = plans.find((candidate) => candidate.id === planId.toLowerCase());
  if (!plan || !ready.ok) notFound();

  return (
    <BookingScreen garage={garage} subtitle="Service plans" back={{ href: "/plans", label: "Back to plans" }}>
      <div className="flex flex-col gap-4 px-5 pt-[18px]">
        <h1 className="m-0 font-display text-[34px] leading-[0.98] font-extrabold text-navy-950">Join {plan.name}</h1>
        <section aria-label="What you get" className="flex flex-col gap-2 rounded-card border border-grey-200 bg-white p-4">
          <p className="m-0 font-display text-[26px] leading-none font-extrabold text-navy-950">{monthlyPrice(plan.pricePence)}</p>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {planBenefitLines(plan).map((line) => (
              <li key={line} className="flex items-start gap-2 text-[14.5px] leading-normal text-grey-800">
                <Check size={17} strokeWidth={2.4} aria-hidden="true" className="mt-0.5 shrink-0 text-success-ink" />
                {line}
              </li>
            ))}
          </ul>
          <p className="m-0 text-[13px] text-grey-600">
            Included services count once per booking, per plan year (from the day you join). The plan is for one car.{" "}
            <Link href="/privacy" className="font-semibold text-accent-text underline underline-offset-2">
              Privacy
            </Link>
          </p>
        </section>
        <PlanSignupForm
          planId={plan.id}
          priceLabel={monthlyPrice(plan.pricePence)}
          payee={garage.name}
          guarantee={guaranteeParagraphs(garage.name)}
          humanCheck={humanCheckConfigured()}
          testMode={getPaymentsProvider()?.kind === "mock"}
        />
      </div>
    </BookingScreen>
  );
}
