import { cn } from "@/lib/utils";

/** Step names of the five-step booking flow. */
export const BOOKING_STEPS = ["Vehicle", "Service", "Time", "Your details", "Confirmed"] as const;

export type StepProgressProps = {
  /** Current step, 1-based. */
  step: number;
  /** Number of steps (5). */
  total?: number;
  /** Step name shown on the right; defaults to the booking step name. */
  label?: string;
  className?: string;
};

/** "Step n of 5", the step name and one segment per step (accent up to the current step). */
export function StepProgress({ step, total = BOOKING_STEPS.length, label, className }: StepProgressProps) {
  const count = Math.max(1, Math.round(total));
  const current = Math.min(Math.max(Math.round(step), 1), count);
  const name = label ?? BOOKING_STEPS[current - 1] ?? "";
  return (
    <div className={cn("flex flex-col gap-2 font-sans leading-[normal]", className)}>
      <p className="m-0 flex items-baseline justify-between gap-3 text-[12px] font-semibold tracking-[0.06em] uppercase">
        <span className="text-grey-600">
          Step {current} of {count}
        </span>
        <span className="text-right text-grey-800">{name}</span>
      </p>
      <div
        role="progressbar"
        aria-label="Booking progress"
        aria-valuemin={1}
        aria-valuemax={count}
        aria-valuenow={current}
        aria-valuetext={`Step ${current} of ${count}${name ? `: ${name}` : ""}`}
        className="flex gap-1.5"
      >
        {Array.from({ length: count }, (_, index) => (
          <span
            key={index}
            data-complete={index < current ? "true" : "false"}
            className={cn("h-1 flex-1 rounded-[4px]", index < current ? "bg-accent" : "bg-[#dfe6ee]")}
          />
        ))}
      </div>
    </div>
  );
}
