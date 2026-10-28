import Link from "next/link";
import { BadgeCheck } from "lucide-react";
import { buttonClass, Panel, SubmitButton, textLinkClass } from "@/components/admin-ui";
import { formatDateKey } from "@/components/admin-ui/format";
import { garageHasFeature } from "@/lib/plans/server";
import { applyPlanToInvoiceAction, cancelPlanSubscriptionAction, releaseBenefitAction, useBenefitAction } from "@/lib/service-plans/admin-actions";
import { loadBookingPlan, loadPlans, loadSubscriptions, loadUsage } from "@/lib/service-plans/server";
import { formatPlanPrice, monthlyPrice, planFlash, type PlanSubscription, type ServicePlan } from "@/lib/service-plans/view";
import type { AdminContext } from "@/lib/tenancy/admin";
import { cn } from "@/lib/utils";
import { PlanNotice, planSummaryClass, SubscriptionStatusBadge } from "./plan-ui";

// Plan panels added to existing admin pages (P5.11): a booking's "On <plan>", a customer's plans,
// a draft invoice's "Apply plan benefits". Server components; reads through the member's RLS client
// (members read plan tables on any plan, so a downgraded garage still sees them), writes through
// src/lib/service-plans/admin-actions.ts. Each renders nothing when there is no plan to show.

type Admin = Pick<AdminContext, "client" | "garage" | "role" | "user">;
type Flash = { done?: string; error?: string };

const CANCEL_ROLES = new Set(["owner", "manager", "front_desk"]);

function dateOf(value: string | null, timeZone: string): string | null {
  if (!value) return null;
  const key = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
  return formatDateKey(key);
}

function statusLine(subscription: PlanSubscription, timeZone: string): string {
  if (subscription.status === "pending_mandate") return "Waiting for the Direct Debit to be set up.";
  if (subscription.status === "cancelled") return `Cancelled${subscription.cancelledAt ? ` ${dateOf(subscription.cancelledAt, timeZone)}` : ""}${subscription.cancelReason ? `: ${subscription.cancelReason}` : ""}.`;
  if (subscription.status === "past_due") return `The last Direct Debit payment failed${subscription.lastPaymentFailedAt ? ` on ${dateOf(subscription.lastPaymentFailedAt, timeZone)}` : ""}. The provider tries again; benefits wait until it's paid.`;
  return `${monthlyPrice(subscription.pricePence)} by Direct Debit${subscription.startedAt ? `, since ${dateOf(subscription.startedAt, timeZone)}` : ""}${subscription.renewsAt ? `. Next payment ${dateOf(subscription.renewsAt, timeZone)}` : ""}.`;
}

function CancelForm({ subscription, returnTo }: { subscription: PlanSubscription; returnTo: string }) {
  return (
    <details>
      <summary className={planSummaryClass}>
        Cancel plan <span className="sr-only">{subscription.planName}</span>
      </summary>
      <form action={cancelPlanSubscriptionAction} className="mt-2 flex flex-col gap-2 rounded-input bg-grey-50 p-3">
        <input type="hidden" name="subscriptionId" value={subscription.id} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <label htmlFor={`cancel-reason-${subscription.id}`} className="text-[14px] font-semibold text-grey-800">
          Reason (optional)
        </label>
        <input id={`cancel-reason-${subscription.id}`} name="reason" maxLength={300} className="h-11 rounded-input border border-grey-300 bg-white px-3 text-[15px]" />
        <p className="m-0 text-[13px] text-grey-600">This stops the Direct Debit now. Payments already taken are not refunded here.</p>
        <SubmitButton className={buttonClass("secondary", "md", "border-[#b91c1c] text-[#991b1b] hover:border-[#991b1b] sm:w-fit")}>Stop Direct Debit and cancel</SubmitButton>
      </form>
    </details>
  );
}

/** Booking page: "On <plan>", whether this booking used an included service, use / give back. */
export async function BookingPlanPanel({ admin, bookingId, flash }: { admin: Admin; bookingId: string; flash?: Flash }) {
  const { data } = await admin.client.from("bookings").select("vehicle_id,service_id,status").eq("garage_id", admin.garage.id).eq("id", bookingId).maybeSingle();
  const booking = data as { vehicle_id: string | null; service_id: string; status: string } | null;
  if (!booking) return null;
  const { subscription, used } = await loadBookingPlan(admin.client, admin.garage.id, bookingId, booking.vehicle_id);
  if (!subscription && !used) return null;
  const enabled = garageHasFeature(admin.garage, "service_plans");
  const plans = subscription ? await loadPlans(admin.client, admin.garage.id) : [];
  const plan = plans.find((candidate) => candidate.id === subscription?.planId) ?? null;
  const inclusion = plan?.inclusions.find((item) => item.serviceId === booking.service_id) ?? null;
  const returnTo = `/app/bookings/${bookingId}`;
  const live = booking.status !== "cancelled" && booking.status !== "no_show";

  return (
    <Panel id="service-plan" title={subscription ? `On ${subscription.planName}` : "Service plan"} actions={subscription ? <SubscriptionStatusBadge status={subscription.status} /> : null}>
      <PlanNotice flash={planFlash(flash?.done, flash?.error)} />
      {subscription ? <p className="m-0 text-[14px] text-grey-700">{statusLine(subscription, admin.garage.timezone || "Europe/London")}</p> : null}
      {plan?.priorityBooking ? <p className="m-0 text-[14px] font-semibold text-navy-950">Priority booking: fit this customer in first.</p> : null}
      {used ? (
        <p className="m-0 flex items-start gap-2 text-[14.5px] font-semibold text-success-ink">
          <BadgeCheck size={18} strokeWidth={2} aria-hidden="true" className="mt-px shrink-0" />
          This booking uses the plan&apos;s included {inclusion?.serviceName ?? "service"}.
        </p>
      ) : inclusion ? (
        <p className="m-0 text-[14px] text-grey-700">{inclusion.serviceName} is included {inclusion.usesPerYear === 1 ? "once" : `${inclusion.usesPerYear} times`} a plan year.</p>
      ) : subscription ? (
        <p className="m-0 text-[14px] text-grey-700">This service isn&apos;t included{plan && plan.discountPercent > 0 ? `; ${plan.discountPercent}% off parts and labour applies on the invoice` : ""}.</p>
      ) : null}
      {enabled && live ? (
        <div className="flex flex-wrap gap-2.5">
          {used ? (
            <form action={releaseBenefitAction}>
              <input type="hidden" name="bookingId" value={bookingId} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <SubmitButton className={buttonClass("secondary", "md")}>Give the included service back</SubmitButton>
            </form>
          ) : inclusion && subscription?.status === "active" ? (
            <form action={useBenefitAction}>
              <input type="hidden" name="bookingId" value={bookingId} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <SubmitButton className={buttonClass("primary", "md")}>Use included {inclusion.serviceName}</SubmitButton>
            </form>
          ) : null}
        </div>
      ) : null}
      {subscription ? (
        <Link href={`/app/customers/${subscription.customerId}#service-plan`} className={cn(textLinkClass, "self-start text-[14px]")}>
          See the customer&apos;s plan
        </Link>
      ) : null}
    </Panel>
  );
}

/** Customer page: each car's plan, this plan year's uses, cancel. */
export async function CustomerPlansPanel({ admin, customerId, flash }: { admin: Admin; customerId: string; flash?: Flash }) {
  const subscriptions = await loadSubscriptions(admin.client, admin.garage.id, { customerId, limit: 20 });
  if (subscriptions.length === 0) return null;
  const timeZone = admin.garage.timezone || "Europe/London";
  const plans = await loadPlans(admin.client, admin.garage.id);
  const usages = await Promise.all(subscriptions.map((subscription) =>
    subscription.status === "cancelled" ? Promise.resolve(null) : loadUsage(admin.client, admin.garage.id, subscription, plans.find((plan) => plan.id === subscription.planId) ?? null, timeZone)));
  const canCancel = CANCEL_ROLES.has(admin.role);
  const returnTo = `/app/customers/${customerId}`;

  return (
    <Panel id="service-plan" title="Service plans" count={subscriptions.filter((item) => item.status !== "cancelled").length} countLabel="live plans">
      <PlanNotice flash={planFlash(flash?.done, flash?.error)} />
      <ul className="m-0 flex list-none flex-col p-0">
        {subscriptions.map((subscription, index) => {
          const usage = usages[index];
          return (
            <li key={subscription.id} className="flex flex-col gap-1.5 border-t border-[#eef2f6] py-3 first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[15px] font-bold text-navy-950">{subscription.planName}</span>
                <SubscriptionStatusBadge status={subscription.status} />
                <span className="text-[13px] text-grey-600">{[subscription.vehicleName, subscription.registration].filter(Boolean).join(" · ")}</span>
              </div>
              <p className="m-0 text-[13.5px] text-grey-700">{statusLine(subscription, timeZone)}</p>
              {usage && usage.usage.length > 0 ? (
                <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label={`${subscription.planName}: included services this plan year`}>
                  {usage.usage.map((item) => (
                    <li key={item.serviceId} className="rounded-full bg-grey-100 px-3 py-1.5 text-[13px] font-semibold text-grey-700">
                      {item.serviceName}: {item.used} of {item.usesPerYear} used
                    </li>
                  ))}
                </ul>
              ) : null}
              {subscription.lastNoticeKind ? (
                <p className="m-0 text-[13px] text-grey-600">
                  {subscription.lastNoticeKind === "confirmation" ? "Sign-up confirmation" : "Payment-failed notice"}:{" "}
                  {subscription.lastNoticeOutcome === "sent" ? `sent by ${subscription.lastNoticeChannel === "email" ? "email" : subscription.lastNoticeChannel === "whatsapp" ? "WhatsApp" : "text"}` : subscription.lastNoticeOutcome === "opted_out" ? "not sent (opted out of texts, no email)" : subscription.lastNoticeOutcome === "no_contact" ? "not sent (no contact details)" : "sending failed"}
                </p>
              ) : null}
              {canCancel && subscription.status !== "cancelled" ? <CancelForm subscription={subscription} returnTo={returnTo} /> : null}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/** Draft invoice for a booking whose car is on an active plan: "Apply plan benefits". */
export async function InvoicePlanPanel({ admin, invoiceId, flash }: { admin: Admin; invoiceId: string; flash?: Flash }) {
  if (!garageHasFeature(admin.garage, "service_plans")) return null;
  const { data } = await admin.client.from("invoices").select("status,booking_id").eq("garage_id", admin.garage.id).eq("id", invoiceId).maybeSingle();
  const invoice = data as { status: string; booking_id: string | null } | null;
  if (!invoice?.booking_id) return null;
  const [{ data: booking }, { data: application }] = await Promise.all([
    admin.client.from("bookings").select("vehicle_id").eq("garage_id", admin.garage.id).eq("id", invoice.booking_id).maybeSingle(),
    admin.client.from("service_plan_invoice_applications").select("included_pence,discount_pence").eq("garage_id", admin.garage.id).eq("invoice_id", invoiceId).maybeSingle(),
  ]);
  const vehicleId = (booking as { vehicle_id?: string | null } | null)?.vehicle_id ?? null;
  const applied = application as { included_pence: number; discount_pence: number } | null;
  const { subscription, used } = await loadBookingPlan(admin.client, admin.garage.id, invoice.booking_id, vehicleId);
  if (!subscription && !applied) return null;
  const plans: ServicePlan[] = subscription ? await loadPlans(admin.client, admin.garage.id) : [];
  const plan = plans.find((candidate) => candidate.id === subscription?.planId) ?? null;
  const returnTo = `/app/invoices/${invoiceId}`;

  return (
    <section id="service-plan" className="scroll-mt-20 rounded-2xl border border-[#E4EAF0] bg-white p-5">
      <h2 className="text-lg font-extrabold text-[#071127]">{subscription ? `On ${subscription.planName}` : "Service plan"}</h2>
      <PlanNotice flash={planFlash(flash?.done, flash?.error)} className="mt-3" />
      {applied ? (
        <p className="mt-2 text-sm text-grey-700">
          Plan benefits applied: {formatPlanPrice(Number(applied.included_pence))} included, {formatPlanPrice(Number(applied.discount_pence))} discount.
        </p>
      ) : invoice.status !== "draft" ? (
        <p className="mt-2 text-sm text-grey-600">Plan benefits can be added to draft invoices.</p>
      ) : subscription?.status !== "active" ? (
        <p className="mt-2 text-sm text-grey-600">The customer&apos;s plan isn&apos;t active ({subscription?.status === "past_due" ? "a payment failed" : "not set up"}), so its benefits aren&apos;t offered.</p>
      ) : (
        <form action={applyPlanToInvoiceAction} className="mt-3 grid gap-2">
          <input type="hidden" name="invoiceId" value={invoiceId} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <p className="m-0 text-sm text-grey-700">
            {used ? "The booked service is included: its line goes to £0.00. " : ""}
            {plan && plan.discountPercent > 0 ? `${plan.discountPercent}% off the other lines is added to the discount.` : ""}
          </p>
          <SubmitButton className={buttonClass("primary", "md", "w-full justify-center")}>Apply plan benefits</SubmitButton>
        </form>
      )}
    </section>
  );
}
