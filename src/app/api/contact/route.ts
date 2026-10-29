import { NextRequest, NextResponse } from "next/server";
import { createPlatformEnquiry, notifyPlatformEnquiry } from "@/lib/platform-enquiries/server";
import { fieldErrors, platformEnquiryRequestSchema } from "@/lib/platform-enquiries/schema";
import { consumeRateLimit, rateLimitIdentifierHash } from "@/lib/rate-limit";
import { verifyTurnstile } from "@/lib/turnstile";

// POST /api/contact: the marketing site's contact form (`/contact`). Admin host only: src/proxy.ts
// answers 404 for it on garage hosts. Order: size and rate limits, zod, Turnstile, then the insert with
// the service key and the email to Vitalos. The enquiry is saved even when the email cannot be sent.

const MAX_BODY_BYTES = 20_000;

function json(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

function failure(message: string, status: number, fields?: Record<string, string>) {
  return json({ success: false, error: { message, ...(fields ? { fields } : {}) } }, status);
}

export async function POST(request: NextRequest) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) return failure("Your message is too long. Shorten it and try again.", 413);

  const ip = (request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip")?.trim() || "unknown").slice(0, 64);
  // Per source, and an overall cap so a flood cannot bury the inbox.
  if (!(await consumeRateLimit(ip, "platform_enquiry_ip", 5, 3_600)) || !(await consumeRateLimit("all", "platform_enquiry_all", 200, 3_600))) {
    return failure("Too many messages from here. Wait an hour and try again.", 429);
  }

  const raw = await request.text().catch(() => "");
  if (raw.length > MAX_BODY_BYTES) return failure("Your message is too long. Shorten it and try again.", 413);
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const parsed = platformEnquiryRequestSchema.safeParse(body);
  if (!parsed.success) return failure("Check the form and try again.", 400, fieldErrors(parsed.error));

  const { turnstileToken, ...enquiry } = parsed.data;
  if (!(await consumeRateLimit(enquiry.email, "platform_enquiry_email", 3, 3_600))) {
    return failure("Too many messages from this email address. Wait an hour and try again.", 429);
  }
  if (!(await verifyTurnstile(turnstileToken, ip === "unknown" ? undefined : ip))) {
    return failure("The security check failed. Refresh the page and try again.", 403);
  }

  let stored;
  try {
    stored = await createPlatformEnquiry(enquiry, { ipHash: ip === "unknown" ? null : rateLimitIdentifierHash(ip) });
  } catch {
    return failure("We couldn't send your message just now. Try again in a few minutes.", 503);
  }
  await notifyPlatformEnquiry(stored);
  return json({ success: true, id: stored.id }, 201);
}
