import Link from "next/link";
import { cn } from "@/lib/utils";
import { badgeTones, type BadgeTone } from "./badge";
import { focusRing } from "./styles";

export type SummaryChip = {
  /** e.g. "2 to approve". */
  label: string;
  tone?: BadgeTone;
  /** Makes the chip a link (to a filter or a section on the page). */
  href?: string;
};

export type SummaryChipsProps = {
  /** Name of the row for screen readers, e.g. "Today at a glance". */
  label: string;
  chips: SummaryChip[];
  className?: string;
};

/**
 * The phone Today counts ("9 cars", "2 to approve"…). Scrolls sideways inside its own box; linked
 * chips keep a 44px touch target without looking taller than drawn.
 */
export function SummaryChips({ label, chips, className }: SummaryChipsProps) {
  if (chips.length === 0) return null;
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cn("-mx-[18px] overflow-x-auto px-[18px] py-1.5 lg:mx-0 lg:px-0", focusRing, className)}
    >
      <ul className="m-0 flex w-max list-none gap-2 p-0">
        {chips.map((chip) => {
          const chipClass = cn(
            "relative inline-flex items-center rounded-full px-3 py-[7px] text-[13px] leading-[normal] whitespace-nowrap no-underline",
            chip.tone === "navy" ? "font-bold" : "font-semibold",
            badgeTones[chip.tone ?? "neutral"],
            chip.tone === "neutral" || !chip.tone ? "text-grey-800" : undefined,
          );
          return (
            <li key={chip.label} className="shrink-0">
              {chip.href ? (
                <Link href={chip.href} className={cn(chipClass, "after:absolute after:inset-x-0 after:-inset-y-1.5", focusRing)}>
                  {chip.label}
                </Link>
              ) : (
                <span className={chipClass}>{chip.label}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
