import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isAgentTokenAudience, isAgentTool, type AgentTokenAudience, type AgentTool } from "@/lib/agent-api/schemas";
import { localDateKey, monthStart } from "@/lib/admin/dates";
import { effectivePlan } from "@/lib/plans/entitlements";
import { loadUsageMonth, type UsageLine } from "@/lib/plans/usage";
import type { Garage } from "@/lib/tenancy/garage";
import { workforceVoiceTarget, type WorkforceConnection } from "./hand-off";

// Settings · AI front desk (P5.12): the owner's switch, the Workforce connection, the garage's agent
// tokens and this month's AI minutes. Reads go through the member's RLS client (selected garage);
// list_agent_tokens() returns rows only to owners and managers and never the hashes.

export type AgentTokenRow = {
  id: string;
  name: string;
  audience: AgentTokenAudience;
  scopes: AgentTool[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type AiFrontDeskSettings = { enabled: boolean; enabledAt: string | null };

/** The first day of the garage-local month, exactly as the Plan page computes it (same meter, same numbers). */
export function usageMonthFirst(garage: Pick<Garage, "timezone">, now: Date = new Date()) {
  return monthStart(localDateKey(now, garage.timezone));
}

export async function loadAiFrontDeskSettings(client: SupabaseClient, garageId: string): Promise<AiFrontDeskSettings | null> {
  const { data, error } = await client.from("ai_front_desk_settings").select("enabled,enabled_at").eq("garage_id", garageId).maybeSingle();
  if (error) return null;
  const row = data as { enabled: boolean; enabled_at: string | null } | null;
  return { enabled: Boolean(row?.enabled), enabledAt: row?.enabled_at ?? null };
}

export async function listAgentTokens(client: SupabaseClient): Promise<AgentTokenRow[] | null> {
  const { data, error } = await client.rpc("list_agent_tokens");
  if (error) return null;
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    name: String(row.name ?? ""),
    audience: isAgentTokenAudience(row.audience) ? row.audience : "workforce",
    scopes: (Array.isArray(row.scopes) ? row.scopes : []).filter(isAgentTool),
    lastUsedAt: (row.last_used_at as string | null) ?? null,
    revokedAt: (row.revoked_at as string | null) ?? null,
    createdAt: String(row.created_at ?? ""),
  }));
}

export function workforceConnection(tokens: AgentTokenRow[], env: Readonly<Record<string, string | undefined>> = process.env): WorkforceConnection {
  const live = tokens.filter((token) => token.audience === "workforce" && !token.revokedAt);
  const lastUsedAt = live.map((token) => token.lastUsedAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
  return { voiceConfigured: workforceVoiceTarget(env) !== null, activeTokens: live.length, lastUsedAt };
}

/** AI front desk minutes this month for the selected garage (owners/managers), against the plan's allowance. */
export async function loadAiMinutesThisMonth(
  client: SupabaseClient,
  garage: Pick<Garage, "plan" | "trialEndsAt" | "planChosen" | "timezone">,
  now: Date = new Date(),
): Promise<UsageLine | null> {
  const plan = effectivePlan({ plan: garage.plan, trialEndsAt: garage.trialEndsAt, planChosen: garage.planChosen }, now);
  const usage = await loadUsageMonth(client, { plan, monthFirst: usageMonthFirst(garage, now) });
  return usage?.ai ?? null;
}
