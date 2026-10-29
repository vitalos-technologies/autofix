import { NextRequest, NextResponse } from "next/server";
import { humanCheckConfigured } from "@/lib/booking-flow/server";
import { createEnquiry } from "@/lib/enquiries/repository";
import { enquiryRequestSchema } from "@/lib/enquiries/schema";
import { createUploadToken } from "@/lib/enquiries/upload-token";
import { consumeRateLimit } from "@/lib/rate-limit";
import { resolveRouteGarage } from "@/lib/tenancy/route";
import { verifyTurnstile } from "@/lib/turnstile";

/**
 * A customer's enquiry for the host's garage: the booking site's contact form (`/contact`) and any
 * SOB-style enquiry. It lands in the garage's Enquiries with the usual emails (src/lib/enquiries/repository.ts).
 */
export async function POST(request: NextRequest) {
  // The garage is the request host's; anything garage-like in the body is ignored.
  const { garage, response } = await resolveRouteGarage();
  if (response) return response;
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!(await consumeRateLimit(ip, "enquiry", 5, 600)) || !(await consumeRateLimit(garage.id, "enquiry_garage", 200, 600))) return NextResponse.json({ success: false, error: { message: "Too many requests. Please wait before trying again." } }, { status: 429 });

  const parsed = enquiryRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ success: false, error: { message: "Check the form and try again.", fields: parsed.error.flatten().fieldErrors } }, { status: 400 });
  // Turnstile is checked whenever it is configured (both keys), as on the booking steps.
  if (humanCheckConfigured() && !(await verifyTurnstile(parsed.data.turnstileToken, ip === "unknown" ? undefined : ip))) {
    return NextResponse.json({ success: false, error: { message: "Security verification failed. Please refresh and try again." } }, { status: 403 });
  }

  try {
    const enquiry = await createEnquiry(garage, parsed.data);
    return NextResponse.json({ success: true, id: enquiry.id, uploadToken: createUploadToken(enquiry.id, garage.id), notificationStatus: enquiry.notificationStatus }, { status: 201 });
  } catch {
    return NextResponse.json({ success: false, error: { message: "We couldn't save your request. Please call or try again shortly." } }, { status: 503 });
  }
}
