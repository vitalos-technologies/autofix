import { twilioWebhookRoute } from "@/lib/messaging/twilio-route";

/**
 * Inbound WhatsApp to a garage's provisioned sender: stored in `messages`; STOP, START and HELP handled.
 * Signature (X-Twilio-Signature) on the raw body first, then the idempotency row, then the work
 * (src/lib/messaging/twilio-webhooks.ts).
 */
export const POST = twilioWebhookRoute("whatsapp");
