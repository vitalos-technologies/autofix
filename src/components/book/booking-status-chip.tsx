import { cn } from "@/lib/utils";

export type BookingStatusChipTone = "success" | "warning" | "info" | "neutral" | "danger";

export type BookingStatusChipProps = {
  /** Customer wording, e.g. "Confirmed" or "Awaiting the garage's OK". */
  label: string;
  tone: BookingStatusChipTone;
  className?: string;
};

/** Every pair passes 4.5:1 (the same pairs as the admin status pills). */
const tones: Record<BookingStatusChipTone, { chip: string; dot: string }> = {
  success: { chip: "bg-success-bg text-success-ink", dot: "bg-success" },
  warning: { chip: "bg-warning-bg text-warning-ink", dot: "bg-[#d97706]" },
  info: { chip: "bg-info-bg text-info-ink", dot: "bg-accent" },
  neutral: { chip: "bg-grey-100 text-grey-700", dot: "bg-grey-600" },
  danger: { chip: "bg-[#fdecec] text-[#991b1b]", dot: "bg-danger" },
};

/** Booking status on customer screens: a rounded chip with a status dot. */
export function BookingStatusChip({ label, tone, className }: BookingStatusChipProps) {
  const style = tones[tone];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-[5px] font-sans text-[12.5px] leading-[normal] font-bold whitespace-nowrap",
        style.chip,
        className,
      )}
    >
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", style.dot)} />
      {label}
    </span>
  );
}
