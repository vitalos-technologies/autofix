import { cn } from "@/lib/utils";
import { RATING_LABELS, RATING_SHORT_LABELS, type HealthCheckRating, type RatingCounts } from "@/lib/health-checks/checklist";

// Red / amber / green chips for health checks (P5.3), admin and customer page. The colour is never
// the only signal: every chip carries its words. Pairs from design/DESIGN.md (all at least 4.5:1).

export const RATING_TONES: Record<HealthCheckRating, { chip: string; dot: string; border: string }> = {
  red: { chip: "bg-[#fdecec] text-[#991b1b]", dot: "bg-[#dc2626]", border: "border-l-[#dc2626]" },
  amber: { chip: "bg-warning-bg text-warning-ink", dot: "bg-[#d97706]", border: "border-l-[#d97706]" },
  green: { chip: "bg-success-bg text-success-ink", dot: "bg-[#16a34a]", border: "border-l-[#16a34a]" },
  not_checked: { chip: "bg-grey-100 text-grey-700", dot: "bg-grey-600", border: "border-l-grey-300" },
};

export function RatingChip({ rating, short = false, className }: { rating: HealthCheckRating; short?: boolean; className?: string }) {
  const tone = RATING_TONES[rating];
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] leading-none font-bold whitespace-nowrap", tone.chip, className)}>
      <span aria-hidden="true" className={cn("size-2 rounded-full", tone.dot)} />
      {short ? RATING_SHORT_LABELS[rating] : RATING_LABELS[rating]}
    </span>
  );
}

/** "2 red · 3 amber · 14 green" as chips, for headers and lists. */
export function RatingSummary({ counts, className }: { counts: RatingCounts; className?: string }) {
  const parts = (["red", "amber", "green"] as const).filter((rating) => counts[rating] > 0);
  if (parts.length === 0) return <span className={cn("text-[14px] text-grey-600", className)}>Nothing rated yet</span>;
  return (
    <ul className={cn("m-0 flex list-none flex-wrap gap-2 p-0", className)} aria-label="Ratings">
      {parts.map((rating) => (
        <li key={rating}>
          <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] font-bold", RATING_TONES[rating].chip)}>
            <span aria-hidden="true" className={cn("size-2 rounded-full", RATING_TONES[rating].dot)} />
            {counts[rating]} {RATING_SHORT_LABELS[rating].toLowerCase()}
          </span>
        </li>
      ))}
    </ul>
  );
}
