import { twilioWebhookRoute } from "@/lib/messaging/twilio-route";

/**
 * Twilio delivery receipts (StatusCallback): `messages` and `reminder_sends` move forward only.
 * Signature (X-Twilio-Signature) on the raw body first, then the idempotency row, then the work
 * (src/lib/messaging/twilio-webhooks.ts).
 */
export const POST = twilioWebhookRoute("status");
