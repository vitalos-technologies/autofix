import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, Clock3, Landmark } from "lucide-react";
import { focusRing } from "@/components/book/styles";
import { cn } from "@/lib/utils";
import { loadSignup, syncMandate, type SignupView } from "@/lib/service-plans/server";
import { readPlanSession } from "@/lib/service-plans/signup-session";
import { monthlyPrice } from "@/lib/service-plans/view";
import { requireSiteGarage } from "@/lib/tenancy/garage";
import { BookingScreen } from "../../_components/booking-screen";
import { PayButton } from "../../pay/pay-button";
import { confirmMockMandateAction } from "../actions";

export const metadata: Metadata = { title: "Your service plan", robots: { index: false, follow: false, nocache: true } };

type ConfirmProps = { params: Promise<{ garageId: string }>; searchParams: Promise<{ done?: string; cancelled?: string; error?: string }> };

function Message({ tone, icon, title, children }: { tone: "success" | "info" | "error"; icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex gap-3 rounded-card border px-4 py-3.5",
        tone === "success" && "border-[#bfe5cb] bg-success-bg text-success-ink",
        tone === "info" && "border-[#c7dcf5] bg-[#eef5fd] text-navy-950",
        tone === "error" && "border-[#f3c4c4] bg-[#fdecec] text-[#991b1b]",
      )}
    >
      <span className="mt-0.5 shrink-0" aria-hidden="true">{icon}</span>
      <div className="flex flex-col gap-1">
        <p className="m-0 text-[15px] font-bold">{title}</p>
        {children ? <div className="m-0 text-[14px] leading-normal">{children}</div> : null}
      </div>
    </div>
  );
}

/**
 * After the sign-up form (P5.11): the sign-up from the sealed `af_plan` cookie only. The mock sets up
 * a test Direct Debit here; with Stripe the customer comes back from the hosted page and the mandate
 * is read back if the webhook has not landed yet.
 */
export default async function ConfirmPlanPage({ params, searchParams }: ConfirmProps) {
  const garage = await requireSiteGarage((await params).garageId);
  const query = await searchParams;
  const subscriptionId = await readPlanSession(garage.id);
  let signup: SignupView | null = subscriptionId ? await loadSignup(garage.id, subscriptionId).catch(() => null) : null;
  if (signup && query.done === "1" && signup.status === "pending_mandate" && (await syncMandate(garage.id, signup).catch(() => false))) {
    signup = { ...signup, status: "active" };
  }

  if (!signup) {
    return (
      <BookingScreen garage={garage} subtitle="Service plans" withActionBar={false}>
        <div className="flex flex-col gap-4 px-5 pt-7 pb-6">
          <h1 className="m-0 font-display text-[34px] leading-[0.98] font-extrabold text-navy-950">We can&apos;t find your sign-up</h1>
          <p className="m-0 text-[15px] leading-normal text-grey-700">Sign-ups are kept on this device for 2 hours. Choose your plan again to carry on.</p>
          <Link href="/plans" className={cn("inline-flex h-[54px] items-center justify-center rounded-control bg-accent px-4 text-[16px] font-bold text-accent-ink no-underline", focusRing)}>
            See the plans
          </Link>
        </div>
      </BookingScreen>
    );
  }

  const price = monthlyPrice(signup.pricePence);
  return (
    <BookingScreen garage={garage} subtitle="Service plans" withActionBar={false}>
      <div className="flex flex-col gap-4 px-5 pt-7 pb-6">
        <h1 className="m-0 font-display text-[34px] leading-[0.98] font-extrabold text-navy-950">
          {signup.status === "active" ? `You're on ${signup.planName}` : signup.status === "cancelled" ? "This plan was cancelled" : "Set up your Direct Debit"}
        </h1>
        {signup.status === "active" ? (
          <Message tone="success" icon={<CircleCheck size={22} strokeWidth={2.2} />} title="Your Direct Debit is set up. Thank you.">
            {garage.name} will collect {price}. A confirmation is on its way by message. Book your car in whenever it needs us.
          </Message>
        ) : null}
        {signup.status === "past_due" ? (
          <Message tone="error" icon={<CircleAlert size={22} strokeWidth={2.2} />} title="Your last payment didn't go through">
            Please check your bank account, or contact {garage.name}.
          </Message>
        ) : null}
        {signup.status === "pending_mandate" && query.done === "1" ? (
          <Message tone="info" icon={<Clock3 size={22} strokeWidth={2.2} />} title="We're confirming your Direct Debit">
            This usually takes a few seconds. <Link href="/plans/confirm" className="font-semibold underline underline-offset-2">Refresh</Link>
          </Message>
        ) : null}
        {signup.status === "pending_mandate" && query.cancelled === "1" ? (
          <Message tone="info" icon={<CircleAlert size={22} strokeWidth={2.2} />} title="Direct Debit not set up">
            Nothing has been set up. You can try again below.
          </Message>
        ) : null}
        {query.error ? (
          <Message tone="error" icon={<CircleAlert size={22} strokeWidth={2.2} />} title={query.error === "limited" ? "Too many tries. Wait a minute and try again." : "That didn't work. Nothing has been set up. Please try again."} />
        ) : null}

        <section aria-label="Your plan" className="flex flex-col gap-2 rounded-card border border-grey-200 bg-white p-4">
          <dl className="m-0 grid gap-2 text-[14px]">
            <div className="flex justify-between gap-3">
              <dt className="text-grey-600">Plan</dt>
              <dd className="m-0 text-right font-semibold text-navy-950">{signup.planName}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-grey-600">Monthly</dt>
              <dd className="m-0 text-right font-semibold text-navy-950">{price}</dd>
            </div>
            {signup.carName ? (
              <div className="flex justify-between gap-3">
                <dt className="text-grey-600">Car</dt>
                <dd className="m-0 text-right text-navy-950">{signup.carName}</dd>
              </div>
            ) : null}
            <div className="flex justify-between gap-3">
              <dt className="text-grey-600">Paid to</dt>
              <dd className="m-0 text-right text-navy-950">{garage.name}</dd>
            </div>
          </dl>
        </section>

        {signup.status === "pending_mandate" && signup.provider === "mock" ? (
          <form action={confirmMockMandateAction} className="flex flex-col gap-3">
            <p className="m-0 flex items-start gap-2 rounded-card border border-dashed border-grey-300 bg-white px-3 py-2.5 text-[13px] leading-normal text-grey-700">
              <Landmark size={16} strokeWidth={2} aria-hidden="true" className="mt-0.5 shrink-0" />
              Test Direct Debit: no bank details are needed and no money moves.
            </p>
            <PayButton label="Set up test Direct Debit" />
          </form>
        ) : null}
        {signup.status === "pending_mandate" && signup.provider === "stripe" && query.done !== "1" ? (
          <Link href="/plans" className={cn("inline-flex h-[54px] items-center justify-center rounded-control bg-accent px-4 text-[16px] font-bold text-accent-ink no-underline", focusRing)}>
            Start again
          </Link>
        ) : null}
        <Link href="/" className="inline-flex min-h-11 items-center justify-center text-[14px] font-semibold text-accent underline underline-offset-2">
          Go to the booking page
        </Link>
      </div>
    </BookingScreen>
  );
}
