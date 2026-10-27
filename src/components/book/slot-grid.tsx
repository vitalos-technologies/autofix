"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";
import { DAY_PERIOD_LABELS, DEFAULT_GARAGE_TIME_ZONE, dayPeriod, formatTime, type DayPeriod } from "./format";
import { focusRing } from "./styles";

/** One row of `available_slots()` (docs/autofix/ARCHITECTURE.md "Booking engine"). */
export type TimeSlot = {
  /** Start, ISO 8601 with offset (`timestamptz`). */
  starts_at: string;
  ends_at?: string;
  /** Free resources at this time; `0` means taken (struck through and disabled). */
  free_count: number;
};

export type SlotGridProps = {
  /** The slots for one day. */
  slots: readonly TimeSlot[];
  /** Selected `starts_at`. */
  selected: string | null;
  onSelect: (startsAt: string) => void;
  /** Garage time zone; slots are grouped and labelled in local time. */
  timeZone?: string;
  /** Shown when there are no slots for the day. */
  emptyMessage?: string;
  className?: string;
};

const PERIODS: readonly DayPeriod[] = ["morning", "afternoon", "evening"];

function instant(value: string | null): number {
  if (!value) return Number.NaN;
  return Date.parse(value);
}

/** Times for one day in three columns, grouped Morning / Afternoon / Evening. Taken times are disabled. */
export function SlotGrid({
  slots,
  selected,
  onSelect,
  timeZone = DEFAULT_GARAGE_TIME_ZONE,
  emptyMessage = "No times left on this day. Try another day.",
  className,
}: SlotGridProps) {
  const baseId = useId();
  const selectedAt = instant(selected);
  const sorted = [...slots]
    .filter((slot) => !Number.isNaN(instant(slot.starts_at)))
    .sort((a, b) => instant(a.starts_at) - instant(b.starts_at));
  const groups = PERIODS.map((period) => ({
    period,
    slots: sorted.filter((slot) => dayPeriod(slot.starts_at, timeZone) === period),
  })).filter((group) => group.slots.length > 0);

  if (groups.length === 0) {
    return (
      <div className={cn("font-sans", className)}>
        <p className="m-0 rounded-control border border-grey-200 bg-white p-3.5 text-[13.5px] text-grey-700">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-2.5 font-sans leading-[normal]", className)}>
      {groups.map((group, index) => {
        const headingId = `${baseId}-${group.period}`;
        return (
          <div key={group.period} className="flex flex-col gap-2.5">
            <p
              id={headingId}
              className={cn("m-0 text-[13px] font-bold tracking-[0.05em] text-grey-600 uppercase", index > 0 && "pt-1.5")}
            >
              {DAY_PERIOD_LABELS[group.period]}
            </p>
            <div role="group" aria-labelledby={headingId} className="grid grid-cols-3 gap-2">
              {group.slots.map((slot) => {
                const time = formatTime(slot.starts_at, timeZone);
                const available = slot.free_count > 0;
                const pressed = available && instant(slot.starts_at) === selectedAt;
                return (
                  <button
                    key={slot.starts_at}
                    type="button"
                    data-start={slot.starts_at}
                    aria-pressed={available ? pressed : undefined}
                    disabled={!available}
                    onClick={() => onSelect(slot.starts_at)}
                    className={cn(
                      "h-12 rounded-input text-[15px] transition-colors",
                      focusRing,
                      !available
                        ? "cursor-not-allowed border border-dashed border-[#d5dde7] bg-transparent font-medium text-[#8a96a5] line-through"
                        : pressed
                          ? "border-2 border-accent bg-accent font-bold text-accent-ink"
                          : "border border-grey-300 bg-white font-semibold text-navy-950 hover:border-accent",
                    )}
                  >
                    {time}
                    {available ? null : (
                      <>
                        {" "}
                        <span className="sr-only">(taken)</span>
                      </>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
