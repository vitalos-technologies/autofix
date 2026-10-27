// Inbound keyword detection for SMS and WhatsApp replies (STOP, START, HELP).
//
// Source: Twilio "Advanced Opt-Out" docs,
// https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out (read 26 Oct 2026).
// Twilio's default English opt-out keywords are STOP, UNSUBSCRIBE, END, QUIT,
// STOPALL, REVOKE, OPTOUT and CANCEL; opt-in START, UNSTOP and YES; help HELP
// and INFO. Twilio matches keywords case-insensitively and, for Messaging
// Services with Advanced Opt-Out, sends `OptOutType` (STOP, START or HELP) in
// the inbound webhook.
//
// Pure and client-safe. CLAUDE.md rule 5: honour STOP immediately, so this is
// deliberately a little stricter than Twilio about honouring opt-outs: a reply
// that starts with an unambiguous opt-out word ("Stop sending these") also
// counts. CANCEL, END and QUIT only count as the whole message, because
// "Cancel my booking" is a normal reply to a garage.

export const OPT_OUT_KEYWORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPTOUT"] as const;
export const OPT_IN_KEYWORDS = ["START", "YES", "UNSTOP"] as const;
export const HELP_KEYWORDS = ["HELP", "INFO"] as const;

/** Opt-out words that also count when they are only the first word of a longer reply. */
const LEADING_OPT_OUT_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "OPTOUT", "REVOKE"]);

const optOut = new Set<string>(OPT_OUT_KEYWORDS);
const optIn = new Set<string>(OPT_IN_KEYWORDS);
const help = new Set<string>(HELP_KEYWORDS);

export type InboundIntent = "stop" | "start" | "help" | "other";

export type ClassifyInboundOptions = {
  /** Twilio's `OptOutType` webhook parameter, when the Messaging Service sends one. It wins over the body. */
  optOutType?: string | null;
};

function normalise(body: string) {
  return body
    .normalize("NFKC")
    .toUpperCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .replace(/\s+/g, " ");
}

/** Classifies an inbound reply as an opt-out, opt-in, help request or anything else. */
export function classifyInbound(body: string | null | undefined, options: ClassifyInboundOptions = {}): InboundIntent {
  const twilioType = options.optOutType?.trim().toUpperCase();
  if (twilioType === "STOP") return "stop";
  if (twilioType === "START") return "start";
  if (twilioType === "HELP") return "help";

  if (typeof body !== "string") return "other";
  const text = normalise(body);
  if (!text) return "other";

  // "Stop all", "Opt-out" and "S.T.O.P" collapse to the keyword.
  const compact = text.replace(/[^\p{L}\p{N}]/gu, "");
  if (optOut.has(compact)) return "stop";
  if (optIn.has(compact)) return "start";
  if (help.has(compact)) return "help";

  const firstWord = text.split(/[^\p{L}\p{N}]+/u)[0] ?? "";
  if (LEADING_OPT_OUT_WORDS.has(firstWord)) return "stop";

  return "other";
}
