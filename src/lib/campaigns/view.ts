// How the Campaigns pages show statuses, times and skip reasons (P5.5). Pure and client-safe.

import type { StatusPillStatus } from "@/components/admin-ui/types";

export type CampaignStatusValue = "draft" | "scheduled" | "sending" | "sent" | "cancelled";

/** The StatusPill for a campaign: its own label, an existing pill's colour. */
export function campaignStatusPill(status: CampaignStatusValue): { status: StatusPillStatus; label: string } {
  switch (status) {
    case "draft":
      return { status: "no_consent", label: "Draft" };
    case "scheduled":
      return { status: "scheduled", label: "Scheduled" };
    case "sending":
      return { status: "sending", label: "Sending" };
    case "sent":
      return { status: "sent", label: "Sent" };
    case "cancelled":
      return { status: "cancelled", label: "Stopped" };
  }
}

/** Why a recipient got nothing, in plain English (campaign_sends.skip_reason). */
export const SKIP_REASON_LABELS: Record<string, string> = {
  opted_out: "Opted out",
  no_consent: "No consent",
  anonymised: "Details removed",
  no_address: "No number or email",
  vehicle_changed: "Car changed owner",
  mot_disabled: "MOTs switched off",
  expired: "Too late to send",
  campaign_cancelled: "Campaign stopped",
  plan_required: "Needs Pro",
};

/** The pill for one recipient: booked beats the send status. */
export function recipientPill(row: { status: string; skipReason: string | null; booked: boolean }): { status: StatusPillStatus; label?: string } {
  if (row.booked) return { status: "booked" };
  if (row.status === "skipped" || row.status === "cancelled") {
    return { status: row.status, label: (row.skipReason && SKIP_REASON_LABELS[row.skipReason]) || undefined };
  }
  const known = ["scheduled", "sending", "sent", "delivered", "failed"] as const;
  return { status: (known as readonly string[]).includes(row.status) ? (row.status as (typeof known)[number]) : "scheduled" };
}

const TIME_FORMAT_CACHE = new Map<string, Intl.DateTimeFormat>();

/** "Thu 12 Nov, 10:00" in the garage's time zone. */
export function formatSendTime(iso: string, timeZone: string): string {
  let format = TIME_FORMAT_CACHE.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
    TIME_FORMAT_CACHE.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute}`;
}

/** `YYYY-MM-DDTHH:MM` for an `<input type="datetime-local">` in the garage's time zone. */
export function localInputValue(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
}
