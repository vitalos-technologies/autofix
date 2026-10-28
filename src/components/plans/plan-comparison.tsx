import { Check, Minus } from "lucide-react";
import { ESSENTIALS_FEATURES, FEATURES, PLAN_NAMES, PLAN_TAGLINES, PRO_FEATURES, type Plan } from "@/lib/plans/features";
import { cn } from "@/lib/utils";

export type PlanComparisonProps = {
  current: Plan;
  /** "£49 a month" or "Price to be confirmed", per plan. */
  prices: Record<Plan, string>;
  /** "Texts included: to be confirmed", per plan. */
  allowances: Record<Plan, string[]>;
};

/**
 * Essentials vs Pro, phone first: two stacked cards at 390px, side by side from `md`. Every feature
 * line comes from FEATURES (src/lib/plans/features.ts), so the comparison can't drift from the checks.
 */
export function PlanComparison({ current, prices, allowances }: PlanComparisonProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {(["essentials", "pro"] as const).map((plan) => {
        const isCurrent = plan === current;
        return (
          <section
            key={plan}
            aria-labelledby={`plan-${plan}-title`}
            className={cn("flex flex-col gap-4 rounded-card border bg-white p-[18px]", isCurrent ? "border-2 border-accent" : "border-grey-200")}
          >
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-3">
                <h3 id={`plan-${plan}-title`} className="m-0 font-display text-[26px] leading-none font-extrabold text-navy-950">
                  {PLAN_NAMES[plan]}
                </h3>
                {isCurrent ? <span className="rounded-full bg-navy-950 px-2.5 py-1 text-[12px] font-bold text-white">Your plan</span> : null}
              </div>
              <p className="m-0 text-[14px] font-semibold text-grey-700">{PLAN_TAGLINES[plan]}</p>
              <p className="m-0 text-[15px] font-bold text-navy-950">{prices[plan]}</p>
              {allowances[plan].map((line) => (
                <p key={line} className="m-0 text-[13.5px] text-grey-700">{line}</p>
              ))}
            </div>
            {plan === "pro" ? <p className="m-0 text-[14px] font-semibold text-navy-950">Everything in Essentials, plus:</p> : null}
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              {(plan === "essentials" ? ESSENTIALS_FEATURES : PRO_FEATURES).map((key) => (
                <li key={key} className="flex gap-2.5">
                  <Check size={18} strokeWidth={2.4} aria-hidden="true" className="mt-0.5 shrink-0 text-[#15803d]" />
                  <span className="flex flex-col">
                    <span className="text-[14px] font-semibold text-navy-950">{FEATURES[key].label}</span>
                    <span className="text-[13px] leading-[1.45] text-grey-700">{FEATURES[key].description}</span>
                  </span>
                </li>
              ))}
              {plan === "essentials" ? (
                <li className="flex gap-2.5">
                  <Minus size={18} strokeWidth={2.4} aria-hidden="true" className="mt-0.5 shrink-0 text-grey-600" />
                  <span className="text-[14px] text-grey-700">No AI front desk: missed calls still get a text back.</span>
                </li>
              ) : null}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
