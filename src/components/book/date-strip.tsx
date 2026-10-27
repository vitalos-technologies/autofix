"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { dayStripParts } from "./format";
import { focusRing } from "./styles";

export type DateStripDay = {
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  /** No free times (or closed). */
  disabled?: boolean;
};

export type DateStripProps = {
  days: readonly DateStripDay[];
  /** Selected `YYYY-MM-DD`. */
  selected: string | null;
  onSelect: (date: string) => void;
  /** Accessible name of the group. */
  label?: string;
  /** Added to the read-out name of disabled days. */
  disabledLabel?: string;
  className?: string;
};

/** Horizontal strip of day buttons (58 × 72). Selected is navy; arrow keys move between days. */
export function DateStrip({
  days,
  selected,
  onSelect,
  label = "Choose a day",
  disabledLabel = "no times left",
  className,
}: DateStripProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !selected) return;
    const button = scroller.querySelector<HTMLButtonElement>(`[data-date="${selected}"]`);
    if (!button) return;
    const padding = 20;
    const left = button.offsetLeft - padding;
    const right = button.offsetLeft + button.offsetWidth + padding - scroller.clientWidth;
    if (scroller.scrollLeft > left) scroller.scrollLeft = Math.max(0, left);
    else if (scroller.scrollLeft < right) scroller.scrollLeft = right;
  }, [selected]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const buttons = Array.from(scrollerRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const index = buttons.findIndex((button) => button === document.activeElement);
    if (index === -1 || buttons.length === 0) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : Math.min(Math.max(index + (event.key === "ArrowRight" ? 1 : -1), 0), buttons.length - 1);
    buttons[next]?.focus();
  }

  // The scroller clips overflow, so it gets 6px of padding for focus rings, cancelled by a negative
  // margin to keep the days where the design puts them.
  return (
    <div
      ref={scrollerRef}
      role="group"
      aria-label={label}
      onKeyDown={handleKeyDown}
      className={cn("relative -my-1.5 flex gap-2 overflow-x-auto px-5 pt-1.5 pb-2.5 font-sans leading-[normal] [scrollbar-width:thin]", className)}
    >
      {days.map((day) => {
        const parts = dayStripParts(day.date);
        const pressed = day.date === selected;
        return (
          <button
            key={day.date}
            type="button"
            data-date={day.date}
            aria-pressed={pressed}
            aria-label={day.disabled ? `${parts.full}, ${disabledLabel}` : parts.full}
            disabled={day.disabled}
            onClick={() => onSelect(day.date)}
            className={cn(
              "flex h-[72px] w-[58px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-control transition-colors",
              focusRing,
              pressed
                ? "border-0 bg-navy-950 text-[#c9d4e2]"
                : day.disabled
                  ? "cursor-not-allowed border border-dashed border-[#d5dde7] bg-transparent text-[#8a96a5]"
                  : "border border-grey-200 bg-white text-grey-700 hover:border-grey-300",
            )}
          >
            <span aria-hidden="true" className="text-[12px] font-semibold">
              {parts.weekday}
            </span>
            <span
              aria-hidden="true"
              className={cn(
                "text-[20px] font-bold",
                pressed ? "text-white" : day.disabled ? "text-[#8a96a5] line-through" : "text-navy-950",
              )}
            >
              {parts.day}
            </span>
          </button>
        );
      })}
    </div>
  );
}
