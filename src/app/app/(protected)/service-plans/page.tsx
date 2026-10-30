import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ExternalLink, Landmark, Repeat } from "lucide-react";
import { Badge, buttonClass, EmptyState, PageHeader, Panel, SubmitButton, textLinkClass } from "@/components/admin-ui";
import { PlateChip } from "@/components/book/plate-chip";
import { ProLockedPage } from "@/components/plans";
import { PlanBenefits, PlanFields, PlanNotice, planSummaryClass, SubscriptionStatusBadge } from "@/components/service-plans/plan-ui";
import { loadPaymentsSetup } from "@/lib/payments/server";
import { garageHasFeature } from "@/lib/plans/server";
import { savePlanAction, setPlanStatusAction } from "@/lib/service-plans/admin-actions";
import { loadPlans, loadSubscriptions, ServicePlansDataError } from "@/lib/service-plans/server";
import { monthlyPrice, planFlash, type PlanSubscription, type ServicePlan } from "@/lib/service-plans/view";
import { getAdminContext } from "@/lib/tenancy/admin";
import { garageUrl } from "@/lib/tenancy/urls";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Service plans" };

type PageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function SubscriptionList({ subscriptions, timeZone }: { subscriptions: PlanSubscription[]; timeZone: string }) {
  const date = (value: string | null) => (value ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone }).format(new Date(value)) : null);
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {subscriptions.map((subscription) => (
        <li key={subscription.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-[#f1f5f9] py-3 first:border-t-0">
          <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-0.5">
            <Link href={`/app/customers/${subscription.customerId}#service-plan`} className={cn(textLinkClass, "self-start text-[15px] font-bold")}>
              {subscription.customerName ?? "Customer"}
            </Link>
            <span className="text-[13px] text-grey-600">
              {subscription.planName} · {monthlyPrice(subscription.pricePence)}
              {subscription.status === "active" && subscription.renewsAt ? ` · next payment ${date(subscription.renewsAt)}` : ""}
              {subscription.status === "cancelled" && subscription.cancelledAt ? ` · cancelled ${date(subscription.cancelledAt)}` : ""}
            </span>
          </div>
          {subscription.registration ? <PlateChip registration={subscription.registration} /> : null}
          <SubscriptionStatusBadge status={subscription.status} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Service plans (P5.11, Pro): the garage's monthly plans paid by Direct Debit (create, edit,
 * archive), the customers on them, and the link to the public /plans page on the booking site.
 * Phone first: one card per plan; desktop: plans beside the "Add a plan" form.
 */
export default async function ServicePlansPage({ searchParams }: PageProps) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  const query = await searchParams;
  const timeZone = admin.garage.timezone || "Europe/London";
  const enabled = garageHasFeature(admin.garage, "service_plans");
  const canManage = admin.role === "owner" || admin.role === "manager";
  const flash = planFlash(first(query.plans), first(query.plansError));

  let plans: ServicePlan[] | null = null;
  let subscriptions: PlanSubscription[] = [];
  try {
    [plans, subscriptions] = await Promise.all([loadPlans(admin.client, admin.garage.id), loadSubscriptions(admin.client, admin.garage.id, { limit: 100 })]);
  } catch (error) {
    if (!(error instanceof ServicePlansDataError)) throw error;
  }
  const live = subscriptions.filter((subscription) => subscription.status !== "cancelled");

  if (!enabled) {
    return (
      <div className="flex flex-col gap-5 pb-10">
        <ProLockedPage feature="service_plans" title="Service plans" canUpgrade={admin.role === "owner"} hasExistingData={subscriptions.length > 0 || (plans?.length ?? 0) > 0} />
        {live.length > 0 ? (
          <div role="alert" className="rounded-card border border-[#f1d9a8] bg-warning-bg px-4 py-3.5 text-[14px] font-semibold text-warning-ink">
            {live.length === 1 ? "1 customer is" : `${live.length} customers are`} still on a plan. Their Direct Debits keep being collected:
            Pitline hasn&apos;t cancelled them. Honour their plans, or cancel each one from the customer&apos;s page, or upgrade to Pro again.
          </div>
        ) : null}
        <PlanNotice flash={flash} />
        {subscriptions.length > 0 ? (
          <Panel title="Customers on plans" count={live.length} countLabel="live plans" padding="flush">
            <SubscriptionList subscriptions={subscriptions} timeZone={timeZone} />
          </Panel>
        ) : null}
      </div>
    );
  }

  const header = (
    <PageHeader
      eyebrow="Grow"
      title="Service plans"
      description="Monthly plans your customers pay by Direct Debit. Included services and discounts are applied at booking and on the invoice."
    />
  );
  if (!plans) {
    return (
      <div className="flex flex-col gap-5 pb-10">
        {header}
        <div role="alert" className="rounded-card border border-[#f3c4c4] bg-[#fdecec] px-4 py-3.5 text-[14px] font-semibold text-[#991b1b]">
          The service plans could not be loaded. Refresh the page to try again.
        </div>
      </div>
    );
  }

  const [setup, servicesResult] = await Promise.all([
    loadPaymentsSetup(admin.garage),
    admin.client.from("services").select("id,name,is_mot").eq("garage_id", admin.garage.id).is("deleted_at", null).order("sort").order("name"),
  ]);
  // MOT is per garage (CLAUDE.md rule 6): an MOT service can be included only when the garage shows MOT.
  const services = ((servicesResult.data ?? []) as { id: string; name: string; is_mot: boolean }[]).filter((service) => admin.garage.motEnabled || !service.is_mot);
  const counts = new Map<string, number>();
  for (const subscription of live) counts.set(subscription.planId, (counts.get(subscription.planId) ?? 0) + 1);
  const publicUrl = garageUrl(admin.garage, "/plans");
  const activePlans = plans.filter((plan) => plan.status === "active");

  return (
    <div className="flex flex-col gap-5 pb-10">
      {header}
      <PlanNotice flash={flash} />
      {!setup.active ? (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-card border border-[#f1d9a8] bg-warning-bg px-4 py-3.5 text-[14px] font-semibold text-warning-ink">
          <Landmark size={18} strokeWidth={2} aria-hidden="true" className="shrink-0" />
          <span className="flex-[1_1_240px]">Connect payments before customers can join: Direct Debits are collected on your own payment account.</span>
          <Link href="/app/payments/settings" className={buttonClass("secondary", "sm", "min-h-11")}>
            Payment settings
          </Link>
        </div>
      ) : null}

      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-5">
          <section aria-labelledby="plans-title" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="plans-title" className="m-0 font-sans text-[17px] font-bold text-navy-950">
                Your plans
              </h2>
              {activePlans.length > 0 && setup.active ? (
                <a href={publicUrl} target="_blank" rel="noreferrer" className={cn(textLinkClass, "min-h-11 gap-1.5 text-[14px]")}>
                  See the sign-up page
                  <ExternalLink size={16} strokeWidth={2} aria-hidden="true" />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              ) : null}
            </div>
            {plans.length === 0 ? (
              <EmptyState
                tone="card"
                icon={Repeat}
                title="No plans yet"
                description={canManage ? "Add a plan: a monthly price and what it includes. Customers join it on your booking site." : "Ask the owner or a manager to add a plan."}
              />
            ) : (
              <ul className="m-0 grid list-none gap-3 p-0 xl:grid-cols-2">
                {plans.map((plan) => (
                  <li key={plan.id} className="flex min-w-0 flex-col gap-3 rounded-card border border-grey-200 bg-white px-4 py-3.5">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                      <h3 className="m-0 font-sans text-[16px] font-bold text-navy-950">{plan.name}</h3>
                      {plan.status === "archived" ? <Badge tone="muted">Archived</Badge> : <Badge tone="success">Open to sign-ups</Badge>}
                    </div>
                    <p className="m-0 font-display text-[24px] leading-none font-extrabold text-navy-950">{monthlyPrice(plan.pricePence)}</p>
                    {plan.description ? <p className="m-0 text-[14px] text-grey-700">{plan.description}</p> : null}
                    <PlanBenefits plan={plan} />
                    <p className="m-0 text-[13px] text-grey-600">
                      {counts.get(plan.id) ?? 0} {(counts.get(plan.id) ?? 0) === 1 ? "customer" : "customers"} on this plan
                    </p>
                    {canManage ? (
                      <details>
                        <summary className={planSummaryClass}>
                          Edit <span className="sr-only">{plan.name}</span>
                        </summary>
                        <div className="mt-2 flex flex-col gap-3 rounded-input bg-grey-50 p-3">
                          <form action={savePlanAction} className="flex flex-col gap-3">
                            <input type="hidden" name="planId" value={plan.id} />
                            <PlanFields idPrefix={`plan-${plan.id}`} plan={plan} services={services} />
                            <SubmitButton className={buttonClass("primary", "md", "w-full sm:w-fit")}>Save {plan.name}</SubmitButton>
                          </form>
                          <form action={setPlanStatusAction} className="border-t border-grey-200 pt-3">
                            <input type="hidden" name="planId" value={plan.id} />
                            <input type="hidden" name="status" value={plan.status === "active" ? "archived" : "active"} />
                            <SubmitButton className={buttonClass("secondary", "md")}>
                              {plan.status === "active" ? `Archive ${plan.name}` : `Restore ${plan.name}`}
                            </SubmitButton>
                            <p className="mt-2 mb-0 text-[13px] text-grey-600">
                              {plan.status === "active" ? "Archiving stops new sign-ups. Customers already on it carry on." : "Restoring opens it to sign-ups again."}
                            </p>
                          </form>
                        </div>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <Panel title="Customers on plans" count={live.length} countLabel="live plans" padding={subscriptions.length ? "flush" : "default"}>
            {subscriptions.length === 0 ? (
              <p className="m-0 text-[14px] text-grey-600">No customers yet. Share your sign-up page, or tell customers at the desk.</p>
            ) : (
              <SubscriptionList subscriptions={subscriptions} timeZone={timeZone} />
            )}
          </Panel>
        </div>

        <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-5">
          {canManage ? (
            <Panel id="add-plan" title="Add a plan">
              <form action={savePlanAction} className="flex flex-col gap-4">
                <PlanFields idPrefix="new-plan" services={services} />
                <SubmitButton className={buttonClass("primary", "md", "w-full sm:w-fit")}>Add plan</SubmitButton>
              </form>
            </Panel>
          ) : null}
          <Panel title="How plans work">
            <ul className="m-0 flex list-disc flex-col gap-2 pl-5 text-[14px] leading-normal text-grey-700">
              <li>Customers join on your booking site and set up a Direct Debit on your payment account. You never see their bank details.</li>
              <li>A booking for a car on a plan shows &ldquo;On &lt;plan&gt;&rdquo;. An included service is counted once per booking, per plan year.</li>
              <li>On the car&apos;s draft invoice, &ldquo;Apply plan benefits&rdquo; sets the included service to £0.00 and adds the discount.</li>
              <li>If a payment fails, the customer gets a message and the plan shows &ldquo;Payment failed&rdquo; until it&apos;s paid.</li>
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
