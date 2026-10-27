import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type KpiTrend = {
  /** e.g. "6 more than last week". */
  label: string;
  /** `positive` = green, `negative` = red, `neutral` = grey. */
  tone?: "positive" | "negative" | "neutral";
};

export type KpiCardProps = {
  label: string;
  /** Already formatted: "23", "71%", "£1,940". */
  value: ReactNode;
  /** Small coloured figure after the number, e.g. "27%". */
  secondaryValue?: ReactNode;
  /** One grey line under the number. */
  context?: ReactNode;
  /** One coloured line under the number (replaces `context`). */
  trend?: KpiTrend;
  /** `navy` for the "won back" card. */
  tone?: "default" | "navy";
  /** `md`: 40px number (Today). `sm`: 36px number (Reminders). */
  size?: "md" | "sm";
  className?: string;
};

const trendColours = {
  default: { positive: "text-success-ink", negative: "text-[#b91c1c]", neutral: "text-grey-600" },
  navy: { positive: "text-[#8ff0b0]", negative: "text-[#fca5a5]", neutral: "text-[#b8c4d4]" },
} as const;

/** One figure: label, Barlow number and a line of context. A `<dl>` so the label is tied to the value. */
export function KpiCard({ label, value, secondaryValue, context, trend, tone = "default", size = "md", className }: KpiCardProps) {
  const navy = tone === "navy";
  const line = trend ? trend.label : context;
  return (
    <dl
      className={cn(
        "m-0 flex min-w-0 flex-col rounded-card font-sans leading-[normal]",
        size === "md" ? "gap-1.5 p-[18px]" : "gap-1 px-[18px] py-4",
        navy ? "bg-navy-950" : "border border-grey-200 bg-white",
        className,
      )}
    >
      <dt className={cn("text-[13px] font-semibold", navy ? "text-[#b8c4d4]" : "text-grey-600")}>{label}</dt>
      <dd
        className={cn(
          "m-0 font-display leading-none font-bold tracking-normal",
          size === "md" ? "text-[40px]" : "text-[36px] leading-[1.2]",
          navy ? "text-white" : "text-navy-950",
        )}
      >
        {value}
        {secondaryValue ? (
          <span className={cn("ml-1.5 text-[18px]", navy ? "text-[#8ff0b0]" : "text-success-ink")}>{secondaryValue}</span>
        ) : null}
      </dd>
      {line ? (
        <dd
          className={cn(
            "m-0 text-[12.5px]",
            trend ? cn("font-semibold", trendColours[tone][trend.tone ?? "positive"]) : navy ? "text-[#b8c4d4]" : "text-grey-600",
          )}
        >
          {line}
        </dd>
      ) : null}
    </dl>
  );
}

/** Four KPI cards: two columns on phones, four from 768px. */
export function KpiGrid({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <div role={label ? "group" : undefined} aria-label={label} className={cn("grid grid-cols-2 gap-2.5 md:grid-cols-4 md:gap-3.5", className)}>
      {children}
    </div>
  );
}
