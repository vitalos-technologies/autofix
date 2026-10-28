// The customer's approve/decline form (P5.3). Client-safe parsing shared by the form and the
// server action: the form posts one JSON field `decisions` with every recommended line, the
// decision and the price the customer saw; the database refuses it if a price changed since.

import { z } from "zod";
import { recommendedItems, type ChecklistItem, type HealthCheckDecision } from "./checklist";

export const decisionSchema = z.object({
  itemId: z.string().uuid(),
  decision: z.enum(["approved", "declined"]),
  pricePence: z.number().int().min(0).max(10_000_000),
});

export const decisionsSchema = z.array(decisionSchema).max(200);
export type CustomerDecision = z.infer<typeof decisionSchema>;

/** Parses the posted field; null when it isn't a list of decisions. */
export function parseDecisions(raw: unknown): CustomerDecision[] | null {
  if (typeof raw !== "string" || raw.length > 40_000) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = decisionsSchema.safeParse(json);
  if (!parsed.success) return null;
  const ids = new Set(parsed.data.map((entry) => entry.itemId));
  return ids.size === parsed.data.length ? parsed.data : null;
}

/** Every recommended line has a choice. Returns the lines still to decide. */
export function undecidedItems(items: ReadonlyArray<Pick<ChecklistItem, "id" | "recommendedWork" | "pricePence">>, choices: Readonly<Record<string, HealthCheckDecision | undefined>>) {
  return recommendedItems(items).filter((item) => !choices[item.id]);
}

/** The payload for record_health_check_decisions(). */
export function toDatabaseDecisions(decisions: readonly CustomerDecision[]) {
  return decisions.map((entry) => ({ item_id: entry.itemId, decision: entry.decision, price_pence: entry.pricePence }));
}

export type DecisionOutcome = "recorded" | "already" | "not_found" | "closed" | "expired" | "plan_required" | "changed" | "invalid";

export const DECISION_MESSAGES: Record<Exclude<DecisionOutcome, "recorded" | "already">, string> = {
  not_found: "We couldn't find this health check. Open the link in your message again.",
  closed: "This health check can't be answered online any more. Call the garage.",
  expired: "This link has expired. Call the garage to approve work.",
  plan_required: "The garage isn't taking approvals online at the moment. Call them to approve work.",
  changed: "The garage has just updated this health check. Look at it again, then confirm.",
  invalid: "Choose approve or decline for each item, then confirm.",
};
