import "server-only";

import type { MessageChannel, OutboundMessage } from "./channel";
import type { MessagingEnv } from "./config";
import { smsSegments } from "./templates";

// P5.2 usage metering: every SMS the platform sends successfully counts its segments against the
// garage's monthly allowance (`usage_events`, metric `sms_segments`, source = the message's
// idempotency key, so a retried send counts once). Metering runs after the send and never changes
// its result: a garage over its allowance still sends; the overage is billed at cost. WhatsApp and
// email are not SMS and are not counted (A303).

export type SmsMeter = (message: OutboundMessage, segments: number) => Promise<unknown>;

const defaultMeter: SmsMeter = async (message, segments) => {
  const { recordUsage } = await import("@/lib/plans/usage");
  return recordUsage({ garageId: message.garageId, metric: "sms_segments", quantity: segments, sourceKey: `sms:${message.idempotencyKey}` });
};

/** Off under Vitest and with `USAGE_METERING=off`; on everywhere else, mock mode included. */
export function isMeteringOn(env: MessagingEnv): boolean {
  return env.USAGE_METERING !== "off" && !env.VITEST && !process.env.VITEST;
}

export function meterSmsChannel(
  channel: MessageChannel,
  env: MessagingEnv,
  meter: SmsMeter = defaultMeter,
  enabled: boolean = isMeteringOn(env),
): MessageChannel {
  if (channel.kind !== "sms" || !enabled) return channel;
  return {
    kind: channel.kind,
    mode: channel.mode,
    async send(message) {
      const result = await channel.send(message);
      if (result.ok && message.garageId && !message.whatsappTemplate) {
        try {
          await meter(message, Math.max(1, smsSegments(message.body).segments));
        } catch {
          // Metering never affects a send.
        }
      }
      return result;
    },
  };
}
