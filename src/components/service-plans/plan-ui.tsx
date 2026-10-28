import type { ReactNode } from "react";
import { Check, CircleAlert, CircleCheck } from "lucide-react";
import { Badge, focusRing } from "@/components/admin-ui";
import { cn } from "@/lib/utils";
import {
  MAX_DISCOUNT_PERCENT,
  MAX_PLAN_DESCRIPTION,
  MAX_PLAN_NAME,
  planBenefitLines,
  SUBSCRIPTION_STATUS_LABELS,
  SUBSCRIPTION_STATUS_TONES,
  type ServicePlan,
  type SubscriptionStatus,
} from "@/lib/service-plans/view";

// P5.11 building blocks for /app/service-plans and the plan panels on the booking, customer and
// invoice pages. Server-compatible plain forms; 44px targets, real labels.

export const planInputClass = cn(
  "h-11 w-full min-w-0 rounded-input border border-grey-300 bg-white px-3 font-sans text-[15px] text-navy-950",
  "focus-visible:border-2 focus-visible:border-accent focus-visible:outline-none",
);
export const planLabelClass = "text-[14px] font-semibold text-grey-800";
export const planSummaryClass = cn(
  "inline-flex min-h-11 cursor-pointer list-none items-center rounded-input px-1 text-[14px] font-semibold text-accent underline underline-offset-2 [&::-webkit-details-marker]:hidden",
  focusRing,
);

export function SubscriptionStatusBadge({ status }: { status: SubscriptionStatus }) {
  return <Badge tone={SUBSCRIPTION_STATUS_TONES[status]}>{SUBSCRIPTION_STATUS_LABELS[status]}</Badge>;
}

export function PlanNotice({ flash, className }: { flash: { tone: "success" | "error"; text: string } | null; className?: string }) {
  if (!flash) return null;
  const success = flash.tone === "success";
  return (
    <div
      role={success ? "status" : "alert"}
      className={cn(
        "flex items-start gap-2 rounded-card px-4 py-3.5 text-[14px] font-semibold",
        success ? "border border-[#bfe5cb] bg-success-bg text-success-ink" : "border border-[#f3c4c4] bg-[#fdecec] text-[#991b1b]",
        className,
      )}
    >
      {success ? <CircleCheck size={18} strokeWidth={2} aria-hidden="true" className="mt-px shrink-0" /> : <CircleAlert size={18} strokeWidth={2} aria-hidden="true" className="mt-px shrink-0" />}
      <span>{flash.text}</span>
    </div>
  );
}

export function PlanBenefits({ plan, className }: { plan: Pick<ServicePlan, "inclusions" | "discountPercent" | "priorityBooking">; className?: string }) {
  const lines = planBenefitLines(plan);
  return (
    <ul className={cn("m-0 flex list-none flex-col gap-1.5 p-0", className)}>
      {lines.map((line) => (
        <li key={line} className="flex items-start gap-2 text-[14px] leading-normal text-grey-800">
          <Check size={16} strokeWidth={2.4} aria-hidden="true" className="mt-0.5 shrink-0 text-success-ink" />
          {line}
        </li>
      ))}
    </ul>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={planLabelClass}>
        {label}
      </label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="m-0 text-[13px] text-grey-600">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Name, description, monthly price, discount, priority and the included services. */
export function PlanFields({ idPrefix, plan, services }: { idPrefix: string; plan?: ServicePlan; services: { id: string; name: string }[] }) {
  const included = new Map((plan?.inclusions ?? []).map((inclusion) => [inclusion.serviceId, inclusion.usesPerYear]));
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${idPrefix}-name`} label="Plan name">
          <input id={`${idPrefix}-name`} name="name" required minLength={2} maxLength={MAX_PLAN_NAME} autoComplete="off" placeholder="Gold care" defaultValue={plan?.name} className={planInputClass} />
        </Field>
        <Field id={`${idPrefix}-price`} label="Monthly price (£)" hint="Taken by Direct Debit each month.">
          <input
            id={`${idPrefix}-price`}
            name="price"
            required
            inputMode="decimal"
            autoComplete="off"
            placeholder="19.99"
            aria-describedby={`${idPrefix}-price-hint`}
            defaultValue={plan ? (plan.pricePence / 100).toFixed(2) : undefined}
            className={planInputClass}
          />
        </Field>
        <Field id={`${idPrefix}-discount`} label="Discount on parts and labour (%)" hint={`0 to ${MAX_DISCOUNT_PERCENT}. Applied on the car's invoices.`}>
          <input
            id={`${idPrefix}-discount`}
            name="discount"
            inputMode="numeric"
            autoComplete="off"
            aria-describedby={`${idPrefix}-discount-hint`}
            defaultValue={plan ? String(plan.discountPercent) : "0"}
            className={planInputClass}
          />
        </Field>
        <div className="flex items-center gap-2.5 self-end sm:min-h-11">
          <input id={`${idPrefix}-priority`} name="priority" type="checkbox" defaultChecked={plan?.priorityBooking ?? false} className="size-5 accent-accent" />
          <label htmlFor={`${idPrefix}-priority`} className={cn(planLabelClass, "min-h-11 content-center")}>
            Priority booking
          </label>
        </div>
        <div className="sm:col-span-2">
          <Field id={`${idPrefix}-description`} label="Description (optional)">
            <textarea id={`${idPrefix}-description`} name="description" rows={2} maxLength={MAX_PLAN_DESCRIPTION} defaultValue={plan?.description ?? undefined} className={cn(planInputClass, "h-auto py-2.5")} />
          </Field>
        </div>
      </div>

      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className={cn(planLabelClass, "mb-1.5 p-0")}>Included services (up to 5)</legend>
        {services.length === 0 ? <p className="m-0 text-[14px] text-grey-600">Add services in Services &amp; prices first.</p> : null}
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {services.map((service) => {
            const checkboxId = `${idPrefix}-include-${service.id}`;
            const usesId = `${idPrefix}-uses-${service.id}`;
            return (
              <li key={service.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-input border border-grey-200 bg-white px-3 py-1.5">
                <div className="flex min-w-0 flex-[1_1_180px] items-center gap-2.5">
                  <input id={checkboxId} name={`include_${service.id}`} type="checkbox" defaultChecked={included.has(service.id)} className="size-5 shrink-0 accent-accent" />
                  <label htmlFor={checkboxId} className="min-h-11 content-center text-[14.5px] font-semibold text-navy-950">
                    {service.name}
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <label htmlFor={usesId} className="text-[13px] text-grey-700">
                    Times a year
                  </label>
                  <select id={usesId} name={`uses_${service.id}`} defaultValue={String(included.get(service.id) ?? 1)} className={cn(planInputClass, "w-20")}>
                    {Array.from({ length: 12 }, (_, index) => index + 1).map((count) => (
                      <option key={count} value={count}>
                        {count}
                      </option>
                    ))}
                  </select>
                </div>
              </li>
            );
          })}
        </ul>
      </fieldset>
    </div>
  );
}
