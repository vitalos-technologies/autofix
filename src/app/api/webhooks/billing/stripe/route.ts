import { NextResponse } from "next/server";
import { getBillingProvider, readStripeBillingConfig } from "@/lib/billing";
import { applyBillingEvent } from "@/lib/billing/server";

// P5.2: Stripe Billing webhook (test mode). Signature on the raw body first; each event is applied
// once (billing_webhook_events). 503 until BILLING_PROVIDER=stripe has a test key, price and secret.

const MAX_BODY = 256 * 1024;

export async function POST(request: Request) {
  if (!readStripeBillingConfig(process.env).config) {
    return NextResponse.json({ error: "Billing webhooks are not configured" }, { status: 503 });
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY) return NextResponse.json({ error: "Too large" }, { status: 413 });
  const raw = await request.text();
  if (raw.length > MAX_BODY) return NextResponse.json({ error: "Too large" }, { status: 413 });

  const event = getBillingProvider().parseWebhook(raw, request.headers.get("stripe-signature"));
  if (!event) return NextResponse.json({ error: "Invalid webhook signature" }, { status: 401 });

  const outcome = await applyBillingEvent(event, "stripe");
  if (outcome === "failed" || outcome === "unavailable") return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  return NextResponse.json({ ok: true, outcome });
}
