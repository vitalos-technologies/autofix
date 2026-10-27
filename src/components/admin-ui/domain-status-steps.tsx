import { Check, Circle, CircleAlert, Clock, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { GarageDomainStatus } from "./types";

export type DomainStepState = "done" | "current" | "upcoming" | "failed";

export type DomainStep = {
  key: "record" | "https" | "live";
  label: string;
  state: DomainStepState;
};

const LABELS: Record<DomainStep["key"], Record<DomainStepState, string>> = {
  record: { done: "Record found", current: "Looking for the record…", upcoming: "Record found", failed: "Record not found" },
  https: { done: "Secured (HTTPS)", current: "Securing (HTTPS)…", upcoming: "Securing (HTTPS)", failed: "HTTPS failed" },
  live: { done: "Live", current: "Going live…", upcoming: "Live", failed: "Not live" },
};

const STATE_TEXT: Record<DomainStepState, string> = {
  done: "done",
  current: "in progress",
  upcoming: "not started",
  failed: "failed",
};

/**
 * `garage_domains.status` → the three steps. `pending_dns`: looking for the record;
 * `verifying`: record found, securing HTTPS; `active`: all done, live; `failed`: the step in
 * `failedStep` (default the first) failed and the rest wait.
 */
export function domainSteps(status: GarageDomainStatus, failedStep: 1 | 2 | 3 = 1): DomainStep[] {
  const keys: DomainStep["key"][] = ["record", "https", "live"];
  const reached = { pending_dns: 0, verifying: 1, active: 3, failed: failedStep - 1 }[status];
  return keys.map((key, index) => {
    let state: DomainStepState;
    if (index < reached) state = "done";
    else if (index === reached) state = status === "failed" ? "failed" : "current";
    else state = "upcoming";
    return { key, label: LABELS[key][state], state };
  });
}

const STYLES: Record<DomainStepState, { box: string; text: string; icon: LucideIcon }> = {
  done: { box: "bg-success-bg", text: "text-success-ink", icon: Check },
  current: { box: "bg-warning-bg", text: "text-warning-ink", icon: Clock },
  upcoming: { box: "bg-grey-100", text: "text-grey-700", icon: Circle },
  failed: { box: "bg-[#fdecec]", text: "text-[#991b1b]", icon: X },
};

export type DomainStatusStepsProps = {
  status: GarageDomainStatus;
  /** `garage_domains.error`, shown when the status is `failed`. */
  error?: string | null;
  /** Which step failed (when known). Default 1. */
  failedStep?: 1 | 2 | 3;
  /** e.g. "book.hartleyroadmotors.co.uk", used in the failure message. */
  hostname?: string;
  className?: string;
};

/** Record found → Securing (HTTPS) → Live, from `garage_domains.status`. */
export function DomainStatusSteps({ status, error, failedStep = 1, hostname, className }: DomainStatusStepsProps) {
  const steps = domainSteps(status, failedStep);
  return (
    <div className={cn("flex flex-col gap-2.5 font-sans leading-[normal]", className)}>
      <ol aria-label="Connection progress" className="m-0 grid list-none grid-cols-1 gap-2.5 p-0 sm:grid-cols-3" data-status={status}>
        {steps.map((step) => {
          const style = STYLES[step.state];
          const Icon = style.icon;
          return (
            <li
              key={step.key}
              data-step={step.key}
              data-state={step.state}
              aria-current={step.state === "current" ? "step" : undefined}
              className={cn("flex items-center gap-2.5 rounded-input p-3", style.box)}
            >
              <Icon size={20} strokeWidth={2} aria-hidden="true" className={cn("shrink-0", style.text)} />
              <span className={cn("text-[13.5px] font-semibold", style.text)}>
                {step.label}
                <span className="sr-only">, {STATE_TEXT[step.state]}</span>
              </span>
            </li>
          );
        })}
      </ol>
      {status === "failed" ? (
        <div className="flex items-start gap-2.5 rounded-input border border-[#f3c4c4] bg-[#fdecec] p-3 text-[14px] text-[#991b1b]">
          <CircleAlert size={20} strokeWidth={2} aria-hidden="true" className="mt-px shrink-0" />
          <p className="m-0 leading-snug">
            <strong>{hostname ? `We couldn't connect ${hostname}.` : "We couldn't connect your address."}</strong>{" "}
            {error?.trim() || "Check the record above matches exactly, then try again."}
          </p>
        </div>
      ) : null}
    </div>
  );
}
