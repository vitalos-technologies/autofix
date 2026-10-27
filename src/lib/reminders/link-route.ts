import "server-only";

import { NextResponse } from "next/server";
import { requesterIp } from "@/lib/booking-engine/http";
import { BOOKING_STATE_COOKIE, bookingStateCookieOptions, sealBookingSession } from "@/lib/booking-engine/state";
import { consumeRateLimit } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/server";
import { getHostGarage, type Garage } from "@/lib/tenancy/garage";
import type { ReminderLinkProblem } from "./link-problems";
import { createSupabaseReminderLinkRepo, openReminderLink, type ReminderLinkRepo } from "./open-link";

// GET /r/{token} on the garage host (rewritten to /_site/[garageId]/r/[token]).
// A good link writes the sealed `af_booking` draft (car, service,
// reminderSendId) and answers 303 to /time (or /service), so neither the
// token nor the registration stays in the address bar, history or a Referer.
// Anything else lands on /r?link=expired|invalid|limited|unavailable, a page
// that explains and links to the booking page.

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" } as const;

/** 303 to a path on this host (relative `Location`, so the garage's own domain is kept). */
function seeOther(path: string) {
  return new NextResponse(null, { status: 303, headers: { ...HEADERS, Location: path } });
}

function problem(kind: ReminderLinkProblem) {
  return seeOther(`/r?link=${kind}`);
}

export type ReminderLinkRouteDeps = {
  hostGarage?: () => Promise<Garage | null>;
  repo?: () => ReminderLinkRepo | null;
  rateLimit?: typeof consumeRateLimit;
  now?: () => Date;
};

export async function handleReminderLinkRequest(
  request: Request,
  params: { garageId: string; token: string },
  deps: ReminderLinkRouteDeps = {},
): Promise<Response> {
  let garage: Garage | null;
  try {
    garage = await (deps.hostGarage ?? getHostGarage)();
  } catch {
    return problem("unavailable");
  }
  if (!garage || garage.id !== params.garageId) return new NextResponse("Not found", { status: 404, headers: HEADERS });

  if (!(await (deps.rateLimit ?? consumeRateLimit)(`${garage.id}:${requesterIp(request)}`, "reminder_link", 30, 600))) return problem("limited");

  const repo = deps.repo
    ? deps.repo()
    : (() => {
        const db = createAdminClient();
        return db ? createSupabaseReminderLinkRepo(db) : null;
      })();
  if (!repo) return problem("unavailable");

  try {
    const opened = await openReminderLink({ garage, token: params.token, repo, now: (deps.now ?? (() => new Date()))() });
    if (!opened.ok) return problem(opened.problem);
    const response = seeOther(opened.next);
    response.cookies.set(BOOKING_STATE_COOKIE, sealBookingSession(opened.draft), bookingStateCookieOptions());
    return response;
  } catch {
    return problem("unavailable");
  }
}
