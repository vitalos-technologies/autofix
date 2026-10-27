import type { NextRequest } from "next/server";
import { manageTokenSchema } from "@/lib/booking-engine/manage-schema";

/**
 * SOB's `/manage-booking` moved to `/manage` for good. Old links keep working: a well-formed link
 * token is passed on (the manage page opens it and drops it from the address); nothing else is.
 * Relative `Location`, so the browser stays on the host it came from.
 */
export function GET(request: NextRequest) {
  const token = manageTokenSchema.safeParse(request.nextUrl.searchParams.get("token") ?? "");
  const location = token.success ? `/manage?token=${encodeURIComponent(token.data)}` : "/manage";
  return new Response(null, {
    status: 308,
    headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}
