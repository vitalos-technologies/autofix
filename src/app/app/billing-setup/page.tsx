import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { signOut } from "@/app/app/login/actions";
import { buttonClass } from "@/components/admin-ui/styles";
import { Notice } from "@/components/onboarding/field";
import { OnboardingFrame } from "@/components/onboarding/onboarding-frame";
import { checkoutAddsVat } from "@/lib/billing";
import { BILLING_SETUP_PATH, billingGate } from "@/lib/billing/gate";
import { formatPlanPrice, getPlansConfig } from "@/lib/plans/config";
import { getAdminContext } from "@/lib/tenancy/admin";
import { startBillingSetupAction } from "./actions";

export const metadata: Metadata = { title: "Finish setting up billing" };

const ERRORS: Record<string, string> = {
  owner_only: "Only the garage owner can add a card, after confirming their sign-in code.",
  billing_unavailable: "Card set-up isn't available just now. Try again in a few minutes.",
};

function longDate(iso: string | null | undefined) {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" }).format(date);
}

/**
 * Finish setting up billing (D26). A card-first garage (garages.card_required) lands here from any admin
 * page until its subscription is trialing, active or past_due: after sign-up, after closing Checkout
 * without a card, and if the subscription later ends. The owner picks the plan and adds a card in Stripe
 * Checkout (£0.00 today while the free month lasts); anyone else is told to ask the owner.
 */
export default async function BillingSetupPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const admin = await getAdminContext({ requireMfa: false, allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  if (admin.mfaState === "enrollment_required") redirect("/app/mfa/enroll");
  if (admin.mfaState === "challenge_required") redirect(`/app/mfa?returnTo=${encodeURIComponent(BILLING_SETUP_PATH)}`);
  const gate = await billingGate(admin.garage.id);
  if (!gate.required) redirect("/app");

  const { done, error } = await searchParams;
  const config = getPlansConfig(process.env);
  const trialEnd = gate.reason === "no_card" ? admin.garage.trialEndsAt : null;
  const now = new Date();
  const freeUntil = trialEnd && Date.parse(trialEnd) > now.getTime() ? longDate(trialEnd) : null;
  const signOutButton = (
    <form action={signOut}>
      <button type="submit" className={buttonClass("ghost", "sm")}>Sign out</button>
    </form>
  );
  const plans = [
    { id: "essentials", name: "Essentials", price: config.essentials.monthlyPricePence },
    { id: "pro", name: "Pro", price: config.pro.monthlyPricePence },
  ] as const;
  const title = gate.reason === "ended" ? "Your subscription has ended" : "Finish setting up billing";
  const description = gate.reason === "ended"
    ? `Add a card to keep using Pitline for ${admin.garage.name}. Nothing you set up has been lost.`
    : `Add a card to start ${admin.garage.name}'s free month. ${freeUntil ? `Nothing is charged today; your card is charged on ${freeUntil} unless you cancel before then.` : "Your card is charged when you subscribe."}`;

  return (
    <OnboardingFrame eyebrow="Billing" title={title} description={description} headerAction={signOutButton}>
      {done === "checkout" ? (
        <Notice tone="success" role="status">
          Card added. We&apos;re finishing your set-up; this takes a few seconds.{" "}
          <Link href="/app" className="font-semibold text-accent-text underline">Continue to Pitline</Link>
        </Notice>
      ) : null}
      {done === "checkout_cancelled" ? <Notice tone="info" role="status">Checkout was closed before a card was added. Your garage is saved; add a card whenever you&apos;re ready.</Notice> : null}
      {error && ERRORS[error] ? <Notice tone="error" role="alert">{ERRORS[error]}</Notice> : null}

      {admin.role !== "owner" ? (
        <Notice tone="info">Your garage&apos;s owner needs to add a card before the team can use Pitline. Ask them to sign in.</Notice>
      ) : (
        <form action={startBillingSetupAction} className="flex flex-col gap-4">
          <fieldset className="m-0 flex flex-col gap-3 rounded-card border border-grey-200 bg-white p-5">
            <legend className="float-left mb-1 w-full p-0 text-[17px] font-bold text-navy-950">Your plan</legend>
            {plans.map((plan) => (
              <label
                key={plan.id}
                className="flex min-h-11 cursor-pointer items-start gap-3 rounded-input border border-grey-300 bg-white px-3.5 py-3 has-[:checked]:border-[#1d4ed8] has-[:checked]:bg-[#eff6ff]"
              >
                <input type="radio" name="plan" value={plan.id} defaultChecked={plan.id === (admin.garage.plan === "essentials" ? "essentials" : "pro")} className="mt-0.5 size-5 shrink-0 accent-[#1d4ed8]" />
                <span className="flex flex-col gap-0.5">
                  <span className="text-[15px] font-bold text-navy-950">{plan.name}</span>
                  <span className="text-[14px] text-grey-700">
                    {freeUntil ? `Free until ${freeUntil}, then ` : ""}{plan.price === null ? "price to be confirmed" : formatPlanPrice(plan.price)}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <button type="submit" className={buttonClass("primary", "md", "min-h-[54px] w-full text-[16px]")}>Add a card</button>
          <p className="m-0 text-[13px] text-grey-700">
            You add the card on Stripe&apos;s secure page.{freeUntil ? " £0.00 is due today." : ""}{checkoutAddsVat() ? " VAT is added at checkout." : ""} Cancel any time in Settings, Plan.
          </p>
        </form>
      )}
    </OnboardingFrame>
  );
}
