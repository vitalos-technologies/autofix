import "server-only";

import { NextResponse } from "next/server";
import { getHostGarage, type Garage } from "@/lib/tenancy/garage";

/** JSON 404 for public API calls that do not arrive on a garage's booking host. */
export function garageNotFoundResponse() {
  return NextResponse.json(
    { success: false, error: { code: "garage_not_found", message: "There is no booking page at this address." } },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * The garage for a public route handler, from the request host only. Request
 * bodies and query strings are never consulted, so `garage_id` sent by a
 * client has no effect.
 */
export async function resolveRouteGarage(): Promise<{ garage: Garage; response?: never } | { garage?: never; response: NextResponse }> {
  let garage: Garage | null;
  try {
    garage = await getHostGarage();
  } catch {
    return {
      response: NextResponse.json(
        { success: false, error: { code: "unavailable", message: "This booking page is temporarily unavailable. Please try again shortly." } },
        { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "30" } },
      ),
    };
  }
  return garage ? { garage } : { response: garageNotFoundResponse() };
}
