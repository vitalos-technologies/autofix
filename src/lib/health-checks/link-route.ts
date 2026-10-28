import "server-only";

import { NextResponse } from "next/server";
import { requesterIp } from "@/lib/booking-engine/http";
import { consumeRateLimit } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/server";
import { getHostGarage, type Garage } from "@/lib/tenancy/garage";
import { createHealthCheckSession, hashHealthCheckToken, HEALTH_CHECK_COOKIE, healthCheckCookieOptions, isHealthCheckToken } from "./token";

// GET /hc/{token} on the garage host (rewritten to /_site/[garageId]/hc/[token]). A good link sets
// the signed httpOnly `af_hc` session (garage + check, 60 minutes) and answers 303 to the clean
// `/health-check` page, so the token never stays in the address bar, history or a Referer (and
// `Referrer-Policy: no-referrer` here and in next.config.ts). Anything else lands on
// `/health-check?link=invalid|expired|limited|unavailable`, which explains and offers a call.

export const HEALTH_CHECK_LINK_PROBLEMS = ["invalid", "expired", "limited", "unavailable"] as const;
export type HealthCheckLinkProblem = (typeof HEALTH_CHECK_LINK_PROBLEMS)[number];

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" } as const;

function seeOther(path: string) {
  return new NextResponse(null, { status: 303, headers: { ...HEADERS, Location: path } });
}

function problem(kind: HealthCheckLinkProblem) {
  const response = seeOther(`/health-check?link=${kind}`);
  // Never leave an earlier check open behind a link that did not work.
  response.cookies.set(HEALTH_CHECK_COOKIE, "", { ...healthCheckCookieOptions(), maxAge: 0 });
  return response;
}

export type OpenLinkResult = { status: "ok"; check_id: string } | { status: "invalid" } | { status: "expired" };

export type HealthCheckLinkDeps = {
  hostGarage?: () => Promise<Garage | null>;
  openLink?: (garageId: string, tokenHash: string) => Promise<OpenLinkResult | null>;
  rateLimit?: typeof consumeRateLimit;
};

async function openLinkWithServiceRole(garageId: string, tokenHash: string): Promise<OpenLinkResult | null> {
  const db = createAdminClient();
  if (!db) return null;
  const { data, error } = await db.rpc("open_health_check_link", { p_garage_id: garageId, p_token_hash: tokenHash });
  if (error || !data) return null;
  return data as OpenLinkResult;
}

export async function handleHealthCheckLinkRequest(request: Request, params: { garageId: string; token: string }, deps: HealthCheckLinkDeps = {}): Promise<Response> {
  let garage: Garage | null;
  try {
    garage = await (deps.hostGarage ?? getHostGarage)();
  } catch {
    return problem("unavailable");
  }
  if (!garage || garage.id !== params.garageId) return new NextResponse("Not found", { status: 404, headers: HEADERS });

  if (!(await (deps.rateLimit ?? consumeRateLimit)(`${garage.id}:${requesterIp(request)}`, "health_check_link", 30, 600))) return problem("limited");
  if (!isHealthCheckToken(params.token)) return problem("invalid");

  let opened: OpenLinkResult | null;
  try {
    opened = await (deps.openLink ?? openLinkWithServiceRole)(garage.id, hashHealthCheckToken(params.token));
  } catch {
    opened = null;
  }
  if (!opened) return problem("unavailable");
  if (opened.status !== "ok") return problem(opened.status);

  const response = seeOther("/health-check");
  response.cookies.set(HEALTH_CHECK_COOKIE, createHealthCheckSession(garage.id, opened.check_id), healthCheckCookieOptions());
  return response;
}
