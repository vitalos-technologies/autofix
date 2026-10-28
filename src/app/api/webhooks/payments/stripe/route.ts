import { NextResponse } from "next/server";
import { getPaymentsProvider, readPaymentsConfig } from "@/lib/payments";
import { applyPaymentsEvent } from "@/lib/payments/server";

// P5.4: Stripe Connect webhook for garages' payments (test mode). Its own signing secret
// (STRIPE_PAYMENTS_WEBHOOK_SECRET, a Connect endpoint), checked on the raw body first; each event is
// applied once (payment_webhook_events). 503 until PAYMENTS_PROVIDER=stripe has a test key and secret.

const MAX_BODY = 256 * 1024;

export async function POST(request: Request) {
  if (readPaymentsConfig(process.env).readiness !== "stripe_test") {
    return NextResponse.json({ error: "Payment webhooks are not configured" }, { status: 503 });
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY) return NextResponse.json({ error: "Too large" }, { status: 413 });
  const raw = await request.text();
  if (raw.length > MAX_BODY) return NextResponse.json({ error: "Too large" }, { status: 413 });

  const provider = getPaymentsProvider();
  const event = provider?.kind === "stripe" ? provider.parseWebhook(raw, request.headers.get("stripe-signature")) : null;
  if (!event) return NextResponse.json({ error: "Invalid webhook signature" }, { status: 401 });

  const outcome = await applyPaymentsEvent(event, "stripe");
  if (outcome === "failed" || outcome === "unavailable") return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  return NextResponse.json({ ok: true, outcome });
}
