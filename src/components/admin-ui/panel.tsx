import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { CountBadge } from "./badge";

export type PanelProps = {
  /** H2 (17px bold navy). Omit for a plain card. */
  title?: ReactNode;
  headingLevel?: 2 | 3;
  /** Accent count next to the title ("Needs your OK 2"). */
  count?: number;
  countLabel?: string;
  /** Before the title, e.g. a StepNumber. */
  leading?: ReactNode;
  /** Right of the title: legend, badge or link. */
  actions?: ReactNode;
  /** 2px accent border, for the step that needs doing (Booking page step 2). */
  highlight?: boolean;
  /** `default` 18px; `flush` keeps 18px sides but no top/bottom padding (lists with their own rows). */
  padding?: "default" | "flush";
  id?: string;
  children?: ReactNode;
  className?: string;
};

/** White 16px-radius section card used across the admin pages. */
export function Panel({
  title,
  headingLevel = 2,
  count,
  countLabel,
  leading,
  actions,
  highlight = false,
  padding = "default",
  id,
  children,
  className,
}: PanelProps) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section
      id={id}
      aria-labelledby={title ? headingId : undefined}
      className={cn(
        "flex min-w-0 flex-col gap-3.5 rounded-card bg-white font-sans leading-[normal]",
        highlight ? "border-2 border-accent" : "border border-grey-200",
        padding === "default" ? "p-[18px]" : "px-[18px] py-1.5",
        className,
      )}
    >
      {title ? (
        <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2", padding === "flush" && "pt-3")}>
          {leading}
          <Heading id={headingId} className="m-0 font-sans text-[17px] font-bold tracking-normal text-navy-950">
            {title}
          </Heading>
          {count ? <CountBadge count={count} label={countLabel} className={actions ? undefined : "ml-auto"} /> : null}
          {actions ? <div className="ml-auto flex flex-wrap items-center gap-3">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export type StepNumberProps = {
  step: number;
  state: "done" | "current" | "upcoming";
};

/** Numbered circle for setup steps: green when done (#15803d for 4.5:1 with white), accent when current, grey when upcoming. */
export function StepNumber({ step, state }: StepNumberProps) {
  return (
    <span
      className={cn(
        "flex size-[26px] shrink-0 items-center justify-center rounded-full text-[13px] font-bold",
        state === "done" && "bg-[#15803d] text-white",
        state === "current" && "bg-accent text-accent-ink",
        state === "upcoming" && "bg-grey-200 text-grey-700",
      )}
    >
      <span aria-hidden="true">{step}</span>
      <span className="sr-only">
        Step {step}
        {state === "done" ? ", done" : state === "current" ? ", to do now" : ""}:
      </span>
    </span>
  );
}
