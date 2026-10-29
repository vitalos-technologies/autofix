"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";
import { focusRing } from "./styles";

export type SegmentedOption<T extends string = string> = {
  value: T;
  label: string;
  disabled?: boolean;
};

export type SegmentedControlProps<T extends string = string> = {
  /** Group label, e.g. "Where?". */
  label: string;
  hideLabel?: boolean;
  /** Usually two (workshop / mobile). The caller hides the control when the garage offers one mode. */
  options: readonly SegmentedOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  /** `segmented` = grey track with a white selected button (Book 2 "Where?");
   *  `outline` = separate outlined buttons (Book 4 "Updates by"). */
  variant?: "segmented" | "outline";
  className?: string;
};

/** Single-choice toggle buttons (`aria-pressed`) in a labelled group. */
export function SegmentedControl<T extends string = string>({
  label,
  hideLabel = false,
  options,
  value,
  onChange,
  variant = "segmented",
  className,
}: SegmentedControlProps<T>) {
  const labelId = useId();
  const columns = { gridTemplateColumns: `repeat(${Math.max(options.length, 1)}, minmax(0, 1fr))` };
  return (
    <div className={cn("flex flex-col gap-2 font-sans leading-[normal]", className)}>
      <span id={labelId} className={cn("text-[14px] font-semibold text-grey-800", hideLabel && "sr-only")}>
        {label}
      </span>
      <div
        role="group"
        aria-labelledby={labelId}
        style={columns}
        className={cn("grid", variant === "segmented" ? "gap-1 rounded-control bg-grey-200 p-1" : "gap-2")}
      >
        {options.map((option) => {
          const pressed = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={pressed}
              disabled={option.disabled}
              onClick={() => onChange(option.value)}
              className={cn(
                "h-11 min-w-0 truncate px-2 text-[14px] transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                focusRing,
                variant === "segmented"
                  ? pressed
                    ? "rounded-[11px] bg-white font-bold text-navy-950 shadow-[0_1px_3px_rgba(7,17,39,0.12)]"
                    : "rounded-[11px] bg-transparent font-semibold text-grey-700 hover:bg-white/60"
                  : pressed
                    ? "rounded-input border-2 border-accent bg-white font-bold text-accent-text"
                    : "rounded-input border border-grey-300 bg-white font-semibold text-grey-700 hover:border-grey-600",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
