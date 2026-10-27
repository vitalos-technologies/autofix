/**
 * Shared prop types for the admin component library. Status and source unions come from the
 * engine contract (docs/autofix/ARCHITECTURE.md) so the UI stays in step with the database.
 */
import type { LucideIcon } from "lucide-react";
import type { BookingSource, BookingStatus } from "@/lib/booking-engine/types";
import type { GarageDomainStatus } from "@/lib/vercel/domains-check";

export type { BookingSource, BookingStatus, GarageDomainStatus };

/** `reminder_sends.status`. */
export type ReminderSendStatus = "scheduled" | "sending" | "sent" | "delivered" | "failed" | "cancelled" | "skipped";

/**
 * Reminder table states that are not a `reminder_sends.status`: `booked` (the send led to a booking,
 * `reminder_sends.booking_id` is set) and `no_consent` (the customer has not opted in, so nothing is sent).
 */
export type ReminderOutcome = "booked" | "no_consent";

/** Everything `StatusPill` can show. `cancelled` is shared by bookings and reminder sends. */
export type StatusPillStatus = BookingStatus | ReminderSendStatus | ReminderOutcome;

/** `reminder_rules.channel`: `customer` means the customer's preferred channel. */
export type ReminderChannel = "sms" | "whatsapp" | "email" | "customer";

/**
 * A form action: a URL (posted with `method="post"`) or a server action / client function.
 * Pass server actions straight through so forms keep working before JavaScript loads.
 */
export type FormAction = string | ((formData: FormData) => void | Promise<void>);

/** A garage the signed-in member can switch to. */
export type AdminGarage = {
  id: string;
  name: string;
  /** Tile initials; worked out from the name when absent. */
  initials?: string;
  /** Garage brand colour (`garages.accent`); darkened automatically if white text would not pass 4.5:1. */
  accent?: string | null;
  /** Second line under the name, e.g. "Growth plan". */
  plan?: string | null;
};

export type AdminNavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Small count after the label, e.g. unseen bookings. Hidden when 0 or absent. */
  badge?: number;
  /** Screen reader text for the badge; default `"{n} new"`. */
  badgeLabel?: string;
};

export type AdminNavGroup = {
  label: string;
  items: AdminNavItem[];
};

export type AdminUser = {
  name: string;
  email: string;
  /** Avatar initials; worked out from the name when absent. */
  initials?: string;
};

export type AdminLink = { label: string; href: string };
