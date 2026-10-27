import { cn } from "@/lib/utils";
import { ONBOARDING_STEPS } from "./steps";

/** "Step n of 6", the step name and one segment per step, like the booking flow's StepProgress. */
export function OnboardingProgress({ step, className }: { step: number; className?: string }) {
  const count = ONBOARDING_STEPS.length;
  const current = Math.min(Math.max(Math.round(step), 1), count);
  const name = ONBOARDING_STEPS[current - 1];
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
        aria-label="Set-up progress"
        aria-valuemin={1}
        aria-valuemax={count}
        aria-valuenow={current}
        aria-valuetext={`Step ${current} of ${count}: ${name}`}
        className="flex gap-1.5"
      >
        {ONBOARDING_STEPS.map((label, index) => (
          <span key={label} className={cn("h-1 flex-1 rounded-[4px]", index < current ? "bg-accent" : "bg-[#dfe6ee]")} />
        ))}
      </div>
    </div>
  );
}
