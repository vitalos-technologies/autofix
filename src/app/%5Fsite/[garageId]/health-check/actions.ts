"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { clientIp } from "@/lib/booking-flow/server";
import { DECISION_MESSAGES, parseDecisions, toDatabaseDecisions, type DecisionOutcome } from "@/lib/health-checks/decisions";
import { HEALTH_CHECK_COOKIE, readHealthCheckSession } from "@/lib/health-checks/token";
import { garageHasFeature } from "@/lib/plans/server";
import { consumeRateLimit } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/server";
import { getGarage } from "@/lib/tenancy/garage";

// The customer's approve/decline (P5.3). The garage is the host's and the check the one the signed
// `af_hc` session opens (never an id from the form). Rate limited per check and address; the
// database makes it idempotent (a second confirm changes nothing) and refuses prices that changed
// since the page was loaded. An Essentials garage's sent check stays readable but takes no new
// decisions (A314).

export type DecisionFormState = { seq: number; status: "idle" | "error"; message?: string };

export async function recordDecisionsAction(previous: DecisionFormState, formData: FormData): Promise<DecisionFormState> {
  const seq = previous.seq + 1;
  const garage = await getGarage();
  const session = readHealthCheckSession((await cookies()).get(HEALTH_CHECK_COOKIE)?.value, garage.id);
  if (!session) return { seq, status: "error", message: "For your security, this page closes after an hour. Open the link in your message again." };
  if (!garageHasFeature(garage, "health_checks")) return { seq, status: "error", message: DECISION_MESSAGES.plan_required };
  if (!(await consumeRateLimit(`${session.checkId}:${await clientIp()}`, "health_check_decide", 10, 600))) {
    return { seq, status: "error", message: "Too many attempts. Please wait a few minutes and try again." };
  }
  const decisions = parseDecisions(formData.get("decisions"));
  if (!decisions) return { seq, status: "error", message: DECISION_MESSAGES.invalid };

  const db = createAdminClient();
  if (!db) return { seq, status: "error", message: "We couldn't save your answer just now. Please try again." };
  const { data, error } = await db.rpc("record_health_check_decisions", {
    p_garage_id: garage.id,
    p_check_id: session.checkId,
    p_decisions: toDatabaseDecisions(decisions),
  });
  if (error || !data) return { seq, status: "error", message: "We couldn't save your answer just now. Please try again." };
  const outcome = (data as { status?: DecisionOutcome }).status ?? "invalid";
  if (outcome !== "recorded" && outcome !== "already") return { seq, status: "error", message: DECISION_MESSAGES[outcome] ?? DECISION_MESSAGES.invalid };
  redirect("/health-check?done=1");
}
