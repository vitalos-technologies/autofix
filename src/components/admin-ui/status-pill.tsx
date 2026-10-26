import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Badge, type BadgeTone } from "./badge";
import type { BookingStatus, ReminderOutcome, ReminderSendStatus, StatusPillStatus } from "./types";

export type StatusPillStyle = {
  label: string;
  /** Shorter label for tight spaces (phone job cards); screen readers still hear `label`. */
  shortLabel?: string;
  tone: BadgeTone;
};

/**
 * Booking statuses (`bookings.status`). Colour rules from design/DESIGN.md: booked = grey,
 * in bay = info, waiting parts and pending = warning, ready = success.
 */
export const BOOKING_STATUS_PILLS: Record<BookingStatus, StatusPillStyle> = {
  requested: { label: "Needs OK", tone: "warning" },
  confirmed: { label: "Booked", tone: "neutral" },
  arrived: { label: "Arrived", tone: "info" },
  in_progress: { label: "In bay", tone: "info" },
  waiting_parts: { label: "Waiting parts", shortLabel: "Parts", tone: "warning" },
  ready: { label: "Ready", tone: "success" },
  collected: { label: "Collected", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "muted" },
  no_show: { label: "No-show", tone: "danger" },
};

/** Reminder send statuses (`reminder_sends.status`) and outcomes. Sent = info, booked = success. */
export const REMINDER_STATUS_PILLS: Record<ReminderSendStatus | ReminderOutcome, StatusPillStyle> = {
  scheduled: { label: "Scheduled", tone: "neutral" },
  sending: { label: "Sending", tone: "info" },
  sent: { label: "Sent", tone: "info" },
  delivered: { label: "Delivered", tone: "info" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "muted" },
  skipped: { label: "Skipped", tone: "muted" },
  booked: { label: "Booked", tone: "success" },
  no_consent: { label: "No consent, won't send", tone: "plain" },
};

export const STATUS_PILLS: Record<StatusPillStatus, StatusPillStyle> = { ...REMINDER_STATUS_PILLS, ...BOOKING_STATUS_PILLS };

/** Human label for a status, e.g. `in_progress` → "In bay". */
export function statusLabel(status: StatusPillStatus): string {
  return STATUS_PILLS[status].label;
}

export type StatusPillProps = {
  status: StatusPillStatus;
  /** Replaces the label, keeping the colour, e.g. "Sent 10 Oct" or "Sends 29 Oct". */
  label?: ReactNode;
  /** Use the short label where one exists ("Parts" for waiting parts). */
  compact?: boolean;
  size?: "sm" | "md";
  className?: string;
};

/** Coloured status chip for bookings and reminder sends. */
export function StatusPill({ status, label, compact = false, size = "md", className }: StatusPillProps) {
  const style = STATUS_PILLS[status];
  const short = compact && !label ? style.shortLabel : undefined;
  return (
    <Badge tone={style.tone} size={size} className={cn(size === "sm" && style.tone !== "plain" && "font-bold", className)}>
      {label ?? (short ? (
        <>
          <span aria-hidden="true">{short}</span>
          <span className="sr-only">{style.label}</span>
        </>
      ) : (
        style.label
      ))}
    </Badge>
  );
}
