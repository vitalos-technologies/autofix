"use client";

import { useActionState, useState } from "react";
import { Check, X } from "lucide-react";
import { focusRing } from "@/components/book/styles";
import { approvedTotalPence, formatPounds, type ChecklistItem, type HealthCheckDecision } from "@/lib/health-checks/checklist";
import { undecidedItems } from "@/lib/health-checks/decisions";
import { cn } from "@/lib/utils";
import { recordDecisionsAction, type DecisionFormState } from "../health-check/actions";
import { FormAlert } from "./booking-screen";
import { managePrimaryAction } from "./manage-ui";

const initial: DecisionFormState = { seq: 0, status: "idle" };

type Recommended = Pick<ChecklistItem, "id" | "label" | "recommendedWork" | "pricePence" | "decision">;

/**
 * The customer's choices (P5.3): Approve / Decline for each recommended job (real radio buttons,
 * 50px), the running total of what they approved and one 54px Confirm. Prices go back with the
 * choices, so the garage changing a price meanwhile is caught.
 */
export function HealthCheckDecisions({ items }: { items: readonly Recommended[] }) {
  const [state, action] = useActionState(recordDecisionsAction, initial);
  const [choices, setChoices] = useState<Record<string, HealthCheckDecision | undefined>>({});
  const total = approvedTotalPence(items, choices);
  const left = undecidedItems(items, choices);
  const payload = JSON.stringify(
    items.filter((item) => choices[item.id]).map((item) => ({ itemId: item.id, decision: choices[item.id], pricePence: item.pricePence ?? 0 })),
  );
  const nothingToDecide = items.length === 0;

  return (
    <form action={action} className="flex flex-col gap-3.5">
      <input type="hidden" name="decisions" value={payload} />
      {items.map((item) => (
        <fieldset key={item.id} className="m-0 flex flex-col gap-2.5 rounded-hero border border-grey-200 bg-white p-4" data-testid="hc-decision">
          <legend className="sr-only">
            {item.recommendedWork}, {formatPounds(item.pricePence ?? 0)}
          </legend>
          <div className="flex items-start justify-between gap-3" aria-hidden="true">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[16px] font-bold text-navy-950">{item.recommendedWork}</span>
              <span className="text-[13px] text-grey-600">{item.label}</span>
            </div>
            <span className="font-display text-[22px] leading-none font-bold text-navy-950">{formatPounds(item.pricePence ?? 0)}</span>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            {(["approved", "declined"] as const).map((value) => {
              const selected = choices[item.id] === value;
              const Icon = value === "approved" ? Check : X;
              return (
                <label
                  key={value}
                  className={cn(
                    "flex h-[50px] cursor-pointer items-center justify-center gap-2 rounded-control border-[1.5px] text-[15px] font-bold transition-colors",
                    "has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-solid",
                    selected
                      ? value === "approved"
                        ? "border-[#15803d] bg-[#15803d] text-white"
                        : "border-navy-950 bg-navy-950 text-white"
                      : "border-grey-300 bg-white text-navy-950 hover:border-navy-950",
                  )}
                >
                  <input
                    type="radio"
                    name={`choice-${item.id}`}
                    value={value}
                    checked={selected}
                    onChange={() => setChoices((current) => ({ ...current, [item.id]: value }))}
                    className="sr-only"
                  />
                  <Icon size={18} strokeWidth={2.4} aria-hidden="true" />
                  {value === "approved" ? "Approve" : "Decline"}
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}

      {nothingToDecide ? null : (
        <div className="flex items-center justify-between gap-3 rounded-hero bg-navy-950 px-4 py-3.5 text-white" aria-live="polite">
          <span className="text-[14px] font-semibold">Approved work</span>
          <span className="font-display text-[26px] leading-none font-bold" data-testid="hc-customer-total">
            {formatPounds(total)}
          </span>
        </div>
      )}
      {state.status === "error" && state.message ? <FormAlert>{state.message}</FormAlert> : null}
      {left.length > 0 ? (
        <p className="m-0 text-center text-[13px] text-grey-600" aria-live="polite">
          Choose approve or decline for {left.length === 1 ? "1 more job" : `${left.length} more jobs`}.
        </p>
      ) : null}
      <button type="submit" disabled={left.length > 0} className={cn(managePrimaryAction, "disabled:cursor-not-allowed disabled:opacity-60", focusRing)}>
        {nothingToDecide ? "Got it, thanks" : left.length > 0 ? "Confirm your choices" : total > 0 ? `Confirm and approve ${formatPounds(total)}` : "Confirm: no extra work"}
      </button>
    </form>
  );
}
