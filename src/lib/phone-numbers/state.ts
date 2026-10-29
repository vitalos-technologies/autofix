// AI front desk numbers (D22): states, what Settings · AI front desk says about each, and the UK
// call-divert instructions. Pure and client-safe.

import { formatPhoneForDisplay } from "@/lib/tenancy/contact";

/** `ai_front_desk_numbers.status` and `twilio_number_provisioning.texting_status`. */
export const NUMBER_STATUSES = ["pending", "waiting_upgrade", "waiting_bundle", "cap_reached", "not_configured", "ready", "failed"] as const;
export type NumberStatus = (typeof NUMBER_STATUSES)[number];
/** Every state but `ready`, which only attach_ai_front_desk_number() sets. */
export type WaitingStatus = Exclude<NumberStatus, "ready">;

export function isNumberStatus(value: unknown): value is NumberStatus {
  return typeof value === "string" && (NUMBER_STATUSES as readonly string[]).includes(value);
}

/** A garage's AI desk number as the settings page reads it (RLS: members of the selected garage). */
export type AiDeskNumber = {
  status: NumberStatus;
  /** Safe code (`twilio:21631`, `no_numbers_available`, …); never provider text. */
  reason: string | null;
  number: string | null;
  checkedAt: string | null;
  readyAt: string | null;
  /** The routing row's `ring_garage_first`; false for a number the platform bought for the desk. */
  ringsGarageFirst: boolean | null;
};

export type NumberStateView = {
  tone: "success" | "warning" | "info" | "neutral" | "danger";
  label: string;
  detail: string;
};

const REASONS: Record<string, string> = {
  no_numbers_available: "Our phone provider had no UK numbers free.",
  number_taken: "The number we picked was already in use on Autofix.",
  already_provisioned: "Your garage already has a different number on record.",
  purchase_unconfirmed: "Our phone provider didn't confirm the order in time.",
};

/** A short, plain explanation of a failure code (codes we don't know are shown as a reference). */
export function reasonText(reason: string | null): string | null {
  if (!reason) return null;
  return REASONS[reason] ?? null;
}

/**
 * What the "Your AI desk number" panel says. `enabled` is the owner's switch: with it off and no number yet,
 * nothing is ordered.
 */
export function aiDeskNumberView(number: AiDeskNumber | null, options: { enabled: boolean }): NumberStateView {
  if (!number || (number.status === "pending" && !options.enabled)) {
    return options.enabled
      ? { tone: "info", label: "Setting up", detail: "We're getting your garage its own number for the AI front desk. It shows here when it's ready." }
      : { tone: "neutral", label: "Not ordered", detail: "Switch the AI front desk on and your garage gets its own number for it, at no extra cost." };
  }
  switch (number.status) {
    case "ready":
      return options.enabled
        ? { tone: "success", label: "Ready", detail: "Calls to this number go to the AI front desk." }
        : { tone: "neutral", label: "Kept", detail: "The AI front desk is off, so calls to this number get your voicemail and a text back. The number stays yours." };
    case "pending":
      return { tone: "info", label: "Setting up", detail: "We're getting your garage its own number for the AI front desk. It shows here when it's ready." };
    case "waiting_upgrade":
      return { tone: "warning", label: "Waiting for upgrade", detail: "Vitalos is upgrading the account with our phone provider (Twilio). Your number is ordered as soon as that's done; we check every day." };
    case "waiting_bundle":
      return { tone: "warning", label: "Waiting for approval", detail: "UK numbers need paperwork approved by our phone provider (Twilio) first. Your number is ordered as soon as it's approved; we check every day." };
    case "cap_reached":
      return { tone: "warning", label: "On the waiting list", detail: "Autofix has reached its limit of phone numbers for now. Your garage is on the list and gets a number as soon as there's room; we check every day." };
    case "not_configured":
      return { tone: "warning", label: "Waiting for Vitalos", detail: "Vitalos is finishing the phone set-up. Your number is ordered as soon as that's done; we check every day." };
    case "failed":
      return { tone: "danger", label: "Couldn't get a number", detail: `${reasonText(number.reason) ?? "Something went wrong ordering your number."} We try again every day. If it keeps happening, contact Vitalos.` };
  }
}

/** `+441302960123` → `01302960123`: what UK phones dial. Null for anything that is not a UK E.164 number. */
export function ukDialString(e164: string | null | undefined): string | null {
  if (typeof e164 !== "string" || !/^\+44[1-9]\d{8,9}$/.test(e164)) return null;
  return `0${e164.slice(3)}`;
}

export type DivertCode = { key: "no_answer" | "busy" | "unreachable"; label: string; code: string };

/**
 * GSM conditional divert codes for a mobile (UK networks): no answer `**61*`, busy `**67*`, unreachable `**62*`;
 * all three at once `**004*`, and `##004#` cancels them. Never `**21*` (divert every call): the phone would
 * stop ringing.
 */
export function mobileDivertCodes(e164: string): { codes: DivertCode[]; allAtOnce: string; cancel: string } | null {
  const dial = ukDialString(e164);
  if (!dial) return null;
  return {
    codes: [
      { key: "no_answer", label: "No answer", code: `**61*${dial}#` },
      { key: "busy", label: "Busy", code: `**67*${dial}#` },
      { key: "unreachable", label: "Off or no signal", code: `**62*${dial}#` },
    ],
    allAtOnce: `**004*${dial}#`,
    cancel: "##004#",
  };
}

/** The landline wording: diversions there are set by the provider (or the phone system), not by a code we can promise. */
export function landlineDivertText(e164: string): string {
  return `Ask your phone provider (for example BT, Virgin Media or whoever runs your phone system) to divert calls to ${formatPhoneForDisplay(e164)} when there's no answer, when the line is busy and when it's unreachable. Ask for a diversion on no answer after about 20 seconds, not for all calls.`;
}
