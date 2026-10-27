import { Wrench } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { OnboardingProgress } from "./onboarding-progress";

export type OnboardingFrameProps = {
  /** 1-based wizard step; omit on screens outside the numbered steps (account, check email, done). */
  step?: number;
  eyebrow?: ReactNode;
  /** The page's H1. Omit when the content renders its own (the garage wizard). */
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** Right of the logo, e.g. a sign-out button. */
  headerAction?: ReactNode;
  width?: "narrow" | "wide";
};

/**
 * Phone-first page for sign-up and onboarding, outside the admin shell: an Autofix bar, the step
 * progress, a Barlow H1 and the step's content in a single column (560px, 720px when wide).
 * The root layout provides <main>.
 */
export function OnboardingFrame({ step, eyebrow, title, description, children, headerAction, width = "narrow" }: OnboardingFrameProps) {
  return (
    <div className="min-h-screen bg-grey-50 font-sans text-grey-800">
      <header className="border-b border-grey-200 bg-white">
        <div className={cn("mx-auto flex min-h-16 items-center justify-between gap-3 px-5", width === "wide" ? "max-w-[720px]" : "max-w-[560px]")}>
          <span className="inline-flex items-center gap-2">
            <span aria-hidden="true" className="grid size-9 place-items-center rounded-lg bg-[#155fba] text-white">
              <Wrench size={18} strokeWidth={2.25} />
            </span>
            <span className="font-display text-[26px] leading-none font-extrabold tracking-tight text-navy-950">Autofix</span>
          </span>
          {headerAction}
        </div>
      </header>
      <div className={cn("mx-auto flex flex-col gap-5 px-5 pt-6 pb-16", width === "wide" ? "max-w-[720px]" : "max-w-[560px]")}>
        {step ? <OnboardingProgress step={step} /> : null}
        {title ? <div className="flex flex-col gap-2">
          {eyebrow ? <p className="m-0 text-[12px] font-bold tracking-[0.08em] text-accent uppercase">{eyebrow}</p> : null}
          <h1 className="m-0 font-display text-[36px] leading-[0.98] font-extrabold text-navy-950">{title}</h1>
          {description ? <p className="m-0 text-[15px] leading-6 text-grey-600">{description}</p> : null}
        </div> : null}
        {children}
      </div>
    </div>
  );
}
