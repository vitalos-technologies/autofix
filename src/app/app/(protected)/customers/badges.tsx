import { Badge } from "@/components/admin-ui";
import { formatMotDate } from "@/lib/vehicle/mot";

/** Reminder state: on (consent, not opted out), opted out, or no consent. */
export function ConsentBadge({ reminderConsent, optedOutAt }: { reminderConsent: boolean; optedOutAt: string | null }) {
  if (optedOutAt) return <Badge tone="danger">Opted out</Badge>;
  if (reminderConsent) return <Badge tone="success">Reminders on</Badge>;
  return <Badge tone="muted">No consent</Badge>;
}

function daysUntil(isoDate: string, today: Date) {
  const due = Date.parse(`${isoDate}T00:00:00Z`);
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((due - start) / 86_400_000);
}

/** MOT expiry: red once expired, amber within 30 days. Only render when the garage has MOT on. */
export function MotDueBadge({ motExpiry, today = new Date() }: { motExpiry: string | null; today?: Date }) {
  if (!motExpiry) return <span className="text-[13px] text-grey-600">Not known</span>;
  const days = daysUntil(motExpiry, today);
  const label = formatMotDate(motExpiry);
  if (days < 0) return <Badge tone="danger">Expired {label}</Badge>;
  if (days <= 30) return <Badge tone="warning">Due {label}</Badge>;
  return <span className="text-[14px] text-grey-800">{label}</span>;
}
