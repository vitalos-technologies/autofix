import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { buttonClass, PageHeader, Panel, SubmitButton } from "@/components/admin-ui";
import { Notice } from "@/components/onboarding/field";
import { PlanComparison, UsageMeter } from "@/components/plans";
import { localDateKey, monthStart } from "@/lib/admin/dates";
import { getBillingReadiness } from "@/lib/billing";
import { loadSubscription } from "@/lib/billing/server";
import { formatPlanPrice, getPlansConfig } from "@/lib/plans/config";
import { effectivePlan, isOnTrial, trialDaysLeft } from "@/lib/plans/entitlements";
import { PLAN_NAMES } from "@/lib/plans/features";
import { loadUsageMonth } from "@/lib/plans/usage";
import { getAdminContext } from "@/lib/tenancy/admin";
import { chooseEssentialsAction, openBillingPortalAction, upgradeToProAction } from "./actions";

export const metadata: Metadata = { title: "Plan" };

const PATH = "/app/settings/plan";

const FLASH: Record<string, { tone: "success" | "error" | "info"; text: string }> = {
  requested: { tone: "success", text: "Thanks. Vitalos has your request for Pro and will be in touch to switch it on." },
  checkout: { tone: "success", text: "Payment set up. Pro switches on as soon as Stripe confirms it, usually within a minute." },
  checkout_cancelled: { tone: "info", text: "Checkout was cancelled. Nothing has changed." },
  essentials: { tone: "success", text: "You're on Essentials. Anything you set up on Pro is kept and stays readable." },
  owner_only: { tone: "error", text: "Only the garage owner can change the plan." },
  billing_unavailable: { tone: "error", text: "Billing isn't available right now. Try again in a few minutes." },
  request_failed: { tone: "error", text: "Your request could not be sent. Try again." },
  change_failed: { tone: "error", text: "The plan could not be changed. Try again." },
  use_portal: { tone: "info", text: "You pay for Pro by card, so change or cancel it in Manage billing." },
};

function formatDate(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone }).format(new Date(iso));
}

function allowanceLine(value: number | null, unit: string) {
  return value === null ? `${unit}: to be confirmed` : `${new Intl.NumberFormat("en-GB").format(value)} ${unit.toLowerCase()} a month`;
}

/**
 * Settings · Plan (P5.2, D17): the current plan and trial, this month's usage against the allowance,
 * Essentials vs Pro, and upgrade/downgrade for owners. Prices and allowances are placeholders until
 * Temitope sets them (src/lib/plans/config.ts), and the page says "to be confirmed" until then.
 */
export default async function PlanSettingsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string; confirm?: string }> }) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  const { done, error, confirm } = await searchParams;
  const flash = FLASH[done ?? ""] ?? FLASH[error ?? ""];
  const garage = admin.garage;
  const now = new Date();
  const state = { plan: garage.plan, trialEndsAt: garage.trialEndsAt, planChosen: garage.planChosen };
  const plan = effectivePlan(state, now);
  const onTrial = isOnTrial(state, now);
  const daysLeft = trialDaysLeft(state, now);
  const isOwner = admin.role === "owner";
  const canSeeUsage = admin.role === "owner" || admin.role === "manager";
  const canChange = isOwner && admin.mfaVerified;
  const config = getPlansConfig(process.env);
  const readiness = getBillingReadiness();
  const selfServe = readiness === "stripe_test";

  const [usage, subscription, request] = await Promise.all([
    canSeeUsage ? loadUsageMonth(admin.client, { plan, monthFirst: monthStart(localDateKey(now, garage.timezone)) }) : Promise.resolve(null),
    isOwner ? loadSubscription(garage.id) : Promise.resolve(null),
    isOwner
      ? admin.client.from("plan_requests").select("requested_plan,created_at").eq("garage_id", garage.id).eq("status", "open").maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const openRequest = (request.data ?? null) as { requested_plan: string; created_at: string } | null;
  const paidByCard = subscription?.provider === "stripe" && ["active", "trialing", "past_due"].includes(subscription.status);

  const summary = onTrial
    ? `Pro trial: ${daysLeft} ${daysLeft === 1 ? "day" : "days"} left, until ${formatDate(garage.trialEndsAt as string, garage.timezone)}.`
    : `${PLAN_NAMES[plan]}.`;
  const afterTrial = onTrial
    ? garage.planChosen === "pro"
      ? "You've chosen Pro, so nothing changes when the trial ends."
      : "When the trial ends you move to Essentials unless you choose Pro. Nothing is deleted: anything you set up on Pro stays, read-only."
    : null;

  return (
    <div className="flex flex-col gap-5 pb-10">
      <PageHeader eyebrow="Settings" title="Plan" description={`What ${garage.name} is on, what it has used this month, and what Pro adds.`} />
      {flash ? <Notice tone={flash.tone} role={flash.tone === "error" ? "alert" : "status"}>{flash.text}</Notice> : null}
      {isOwner && !admin.mfaVerified ? (
        <Notice tone="warning">
          To change the plan, verify your sign-in first.{" "}
          <Link href={`/app/mfa?returnTo=${encodeURIComponent(PATH)}&stepUp=1`} className="underline">Verify now</Link>
        </Notice>
      ) : null}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Panel id="current-plan" title="Your plan">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <p className="m-0 font-display text-[30px] leading-none font-extrabold text-navy-950">{onTrial ? "Pro trial" : PLAN_NAMES[plan]}</p>
              <p className="m-0 text-[15px] text-grey-700">{summary}</p>
              {afterTrial ? <p className="m-0 text-[14px] text-grey-700">{afterTrial}</p> : null}
              {openRequest ? (
                <p className="m-0 text-[14px] font-semibold text-info-ink">
                  You asked Vitalos for {PLAN_NAMES[openRequest.requested_plan as "pro" | "essentials"] ?? "a change"} on {formatDate(openRequest.created_at, garage.timezone)}. We&apos;ll be in touch.
                </p>
              ) : null}
            </div>

            {!isOwner ? (
              <p className="m-0 text-[14px] text-grey-700">Only the garage owner can change the plan.</p>
            ) : (
              <div className="flex flex-col gap-3">
                {plan !== "pro" || (onTrial && garage.planChosen !== "pro") ? (
                  <form action={upgradeToProAction} className="flex flex-col gap-3">
                    {!selfServe ? (
                      <label className="flex flex-col gap-1.5 text-[14px] font-semibold text-navy-950">
                        Anything Vitalos should know? (optional)
                        <textarea
                          name="note"
                          maxLength={500}
                          rows={2}
                          disabled={!canChange}
                          className="min-h-11 rounded-input border border-grey-300 bg-white px-3 py-2 text-[15px] font-normal text-navy-950"
                        />
                      </label>
                    ) : null}
                    <SubmitButton className={buttonClass("primary", "md", "w-full sm:w-fit")} disabled={!canChange}>
                      {selfServe ? (onTrial ? "Choose Pro" : "Upgrade to Pro") : openRequest ? "Send the request again" : "Request Pro"}
                    </SubmitButton>
                    {!selfServe ? <p className="m-0 text-[13px] text-grey-700">Vitalos switches Pro on for you and sets up billing.</p> : null}
                  </form>
                ) : null}
                {paidByCard ? (
                  <form action={openBillingPortalAction}>
                    <SubmitButton className={buttonClass("secondary", "md", "w-full sm:w-fit")} disabled={!canChange}>Manage billing</SubmitButton>
                  </form>
                ) : null}
                {plan === "pro" && !paidByCard ? (
                  confirm === "essentials" ? (
                    <form action={chooseEssentialsAction} className="flex flex-col gap-3 rounded-input border border-grey-200 bg-grey-50 p-3">
                      <p className="m-0 text-[14px] text-navy-950">
                        Move to Essentials now? {onTrial ? "Your trial ends today. " : ""}Pro features lock straight away; what you set up on Pro is kept, read-only.
                      </p>
                      <input type="hidden" name="confirm" value="yes" />
                      <div className="flex flex-wrap gap-2">
                        <SubmitButton className={buttonClass("secondary", "md")} disabled={!canChange}>Yes, move to Essentials</SubmitButton>
                        <Link href={PATH} className={buttonClass("ghost", "md")}>Keep Pro</Link>
                      </div>
                    </form>
                  ) : (
                    <form action={chooseEssentialsAction}>
                      <SubmitButton className={buttonClass("ghost", "md", "w-full sm:w-fit")} disabled={!canChange}>Move to Essentials</SubmitButton>
                    </form>
                  )
                ) : null}
              </div>
            )}
          </div>
        </Panel>

        {canSeeUsage ? (
          <Panel id="usage" title="This month">
            {usage ? (
              <div className="flex flex-col gap-5">
                <UsageMeter line={usage.sms} note="Every text segment sent counts, reminders and replies included. Texts never stop at the allowance; extra texts are billed at cost." />
                {plan === "pro" ? (
                  <UsageMeter line={usage.ai} note="Minutes the AI front desk spends on calls and WhatsApp." />
                ) : (
                  <p className="m-0 text-[14px] text-grey-700">The AI front desk and its minutes come with Pro.</p>
                )}
              </div>
            ) : (
              <p className="m-0 text-[14px] text-grey-700">Usage could not be loaded. Try again later.</p>
            )}
          </Panel>
        ) : null}
      </div>

      <section id="compare" aria-labelledby="compare-title" className="flex scroll-mt-6 flex-col gap-3">
        <h2 id="compare-title" className="m-0 text-[20px] font-bold text-navy-950">Essentials and Pro</h2>
        <PlanComparison
          current={plan}
          prices={{ essentials: formatPlanPrice(config.essentials.monthlyPricePence), pro: formatPlanPrice(config.pro.monthlyPricePence) }}
          allowances={{
            essentials: [allowanceLine(config.essentials.smsAllowance, "Texts")],
            pro: [
              allowanceLine(config.pro.smsAllowance, "Texts"),
              allowanceLine(config.pro.aiMinutesAllowance, "AI front desk minutes"),
              config.extraSitePricePence === null ? "Extra sites: price to be confirmed" : `Extra sites: ${formatPlanPrice(config.extraSitePricePence)} each`,
            ],
          }}
        />
        <p className="m-0 text-[13px] text-grey-700">Texts over the allowance are billed at cost. New garages get Pro free for {config.trialDays} days.</p>
      </section>
    </div>
  );
}
