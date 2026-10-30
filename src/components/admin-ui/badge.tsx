import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { ReminderChannel } from "./types";

export type BadgeTone = "neutral" | "info" | "warning" | "success" | "danger" | "muted" | "accent" | "navy" | "plain";

/**
 * Chip colours (design/DESIGN.md "Colour"). Every pair passes 4.5:1:
 * neutral #475569 on #f1f5f9, info #0d3b7a on #dbe8fb, warning #6e4a06 on #fdf1d3,
 * success #166534 on #e7f6ec, danger #991b1b on #fdecec.
 */
export const badgeTones: Record<BadgeTone, string> = {
  neutral: "bg-grey-100 text-grey-700",
  info: "bg-info-bg text-info-ink",
  warning: "bg-warning-bg text-warning-ink",
  success: "bg-success-bg text-success-ink",
  danger: "bg-[#fdecec] text-[#991b1b]",
  muted: "border border-grey-300 bg-white text-grey-600",
  accent: "bg-accent text-accent-ink",
  navy: "bg-navy-950 text-white",
  plain: "bg-transparent px-0! text-grey-600",
};

const sizes = {
  xs: "px-[7px] py-[2px] text-[11px] font-bold",
  sm: "px-[9px] py-1 text-[12px] font-semibold",
  md: "px-[9px] py-[5px] text-[12px] font-bold",
  lg: "px-3 py-[7px] text-[13px] font-semibold",
} as const;

export type BadgeProps = {
  tone?: BadgeTone;
  size?: keyof typeof sizes;
  children: ReactNode;
  className?: string;
};

/** Small rounded label: channel, count, plan or state. Not interactive. */
export function Badge({ tone = "neutral", size = "sm", children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full leading-[normal] whitespace-nowrap",
        sizes[size],
        badgeTones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export const CHANNEL_LABELS: Record<ReminderChannel, string> = {
  sms: "SMS",
  whatsapp: "WhatsApp",
  email: "Email",
  customer: "Customer's choice",
};

const CHANNEL_TONES: Record<ReminderChannel, BadgeTone> = {
  sms: "neutral",
  whatsapp: "success",
  email: "info",
  customer: "neutral",
};

/** SMS (grey), WhatsApp (green), Email (blue) or the customer's own choice. */
export function ChannelBadge({ channel, className }: { channel: ReminderChannel; className?: string }) {
  return (
    <Badge tone={CHANNEL_TONES[channel]} className={className}>
      {CHANNEL_LABELS[channel]}
    </Badge>
  );
}

/** Accent count pill ("Needs your OK 2", nav badges). Renders nothing for 0. */
export function CountBadge({ count, label, className }: { count: number; label?: string; className?: string }) {
  if (!count || count < 0) return null;
  const shown = count > 99 ? "99+" : String(count);
  return (
    <Badge tone="accent" size="xs" className={cn("min-w-[22px] justify-center text-[12px]", className)}>
      <span aria-hidden={label ? true : undefined}>{shown}</span>
      {label ? <span className="sr-only">{label}</span> : null}
    </Badge>
  );
}
