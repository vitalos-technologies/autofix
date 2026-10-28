// P5.6: what one SMS segment costs Vitalos, for the reminder return report. NOT SET YET
// (Waiting on Temitope, with the plan prices and allowances): null until SMS_SEGMENT_COST_PENCE is
// set, and the report then shows segment counts only. Client-safe: reads only the env passed in.

export const SMS_SEGMENT_COST_ENV = "SMS_SEGMENT_COST_PENCE";

/** Pence per SMS segment (decimals allowed, e.g. 3.5), or null when not set or not a sensible number. */
export function smsSegmentCostPence(env: Record<string, string | undefined> = {}): number | null {
  const raw = env[SMS_SEGMENT_COST_ENV];
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}
