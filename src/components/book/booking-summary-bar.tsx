import Link from "next/link";
import { cn } from "@/lib/utils";
import { DEFAULT_GARAGE_TIME_ZONE, formatSummaryWhen } from "./format";
import { PlateChip } from "./plate-chip";
import { focusRingOnDark } from "./styles";

export type BookingSummaryBarProps = {
  registration: string;
  /** Service name. */
  service: string;
  /** Where, e.g. "Workshop" or "Mobile visit". */
  mode?: string | null;
  /** Slot start (ISO). */
  start: string;
  timeZone?: string;
  /** Step to go back to; no Edit link when omitted (e.g. the cancel confirmation). */
  editHref?: string | null;
  /** Read-out name of the Edit link. */
  editLabel?: string;
  className?: string;
};

/** Navy card with the booking so far: plate, service · mode, date · time and an Edit link. */
export function BookingSummaryBar({
  registration,
  service,
  mode,
  start,
  timeZone = DEFAULT_GARAGE_TIME_ZONE,
  editHref,
  editLabel = "Edit booking",
  className,
}: BookingSummaryBarProps) {
  return (
    <div className={cn("flex items-center gap-3 rounded-card bg-navy-950 py-3.5 pl-4 font-sans leading-[normal] text-white", editHref ? "pr-1.5" : "pr-4", className)}>
      <PlateChip registration={registration} size="md" />
      <div className="flex min-w-0 grow flex-col gap-0.5">
        <p className="m-0 text-[14px] font-bold">{[service, mode].filter(Boolean).join(" · ")}</p>
        <p className="m-0 text-[12.5px] text-[#b8c4d4]">{formatSummaryWhen(start, timeZone)}</p>
      </div>
      {editHref ? (
        <Link
          href={editHref}
          aria-label={editLabel}
          className={cn(
            "-my-[5px] inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-input px-2 text-[13px] font-semibold text-[#9cc8ff] underline underline-offset-2 hover:text-white",
            focusRingOnDark,
          )}
        >
          Edit
        </Link>
      ) : null}
    </div>
  );
}
