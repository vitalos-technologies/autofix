import { twilioWebhookRoute } from "@/lib/messaging/twilio-route";

/**
 * Calls to a garage's Autofix number: logged in `calls`, answered with minimal TwiML (P4.1 adds text-back).
 * Calls to Autofix's own line (AUTOFIX_PLATFORM_VOICE_NUMBERS, A420): logged in `platform_calls`, voicemail only.
 * Signature (X-Twilio-Signature) on the raw body first, then the idempotency row, then the work
 * (src/lib/messaging/twilio-webhooks.ts).
 */
export const POST = twilioWebhookRoute("voice");
