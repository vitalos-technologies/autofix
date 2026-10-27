"use client";

import { useActionState, useId, useState } from "react";
import { buttonClass } from "@/components/admin-ui/styles";
import { SubmitButton } from "@/components/admin-ui/submit-button";
import {
  retryJobAction,
  startImpersonationAction,
  startPlatformEnrolmentAction,
  updateGarageAction,
  verifyPlatformMfaAction,
  type PlatformEnrolment,
  type PlatformFormState,
} from "@/lib/platform/actions";
import {
  GARAGE_PLANS,
  GARAGE_STATUSES,
  IMPERSONATION_MAX_MINUTES,
  IMPERSONATION_MIN_MINUTES,
  IMPERSONATION_MINUTES,
  PLAN_LABELS,
  REASON_MAX,
  REASON_MIN,
  STATUS_LABELS,
  type GaragePlan,
  type GarageStatus,
} from "@/lib/platform/policy";
import { cn } from "@/lib/utils";
import { fieldClass, labelClass } from "./field-styles";

const idle: PlatformFormState = { status: "idle", message: "" };

function Message({ state }: { state: PlatformFormState }) {
  if (!state.message) return <p role="status" className="sr-only" />;
  return (
    <p
      role={state.status === "error" ? "alert" : "status"}
      className={cn(
        "m-0 rounded-input px-3 py-2.5 text-[14px] font-semibold",
        state.status === "error" ? "bg-[#fdecec] text-[#991b1b]" : "bg-success-bg text-success-ink",
      )}
    >
      {state.message}
    </p>
  );
}

function ReasonField({ id, hint }: { id: string; hint: string }) {
  return (
    <div>
      <label htmlFor={id} className={labelClass}>Reason</label>
      <p id={`${id}-hint`} className="m-0 mt-0.5 text-[13px] text-grey-600">{hint}</p>
      <textarea
        id={id}
        name="reason"
        required
        minLength={REASON_MIN}
        maxLength={REASON_MAX}
        rows={2}
        aria-describedby={`${id}-hint`}
        className={cn(fieldClass, "py-2")}
      />
    </div>
  );
}

export function GarageChangeForm({ garageId, plan, status }: { garageId: string; plan: GaragePlan; status: GarageStatus }) {
  const [state, action] = useActionState(updateGarageAction, idle);
  const id = useId();
  return (
    <form action={action} className="flex flex-col gap-3.5">
      <input type="hidden" name="garageId" value={garageId} />
      <div className="grid gap-3.5 sm:grid-cols-2">
        <div>
          <label htmlFor={`${id}-plan`} className={labelClass}>Plan</label>
          <select id={`${id}-plan`} name="plan" defaultValue={plan} className={fieldClass}>
            {GARAGE_PLANS.map((value) => <option key={value} value={value}>{PLAN_LABELS[value]}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-status`} className={labelClass}>Status</label>
          <select id={`${id}-status`} name="status" defaultValue={status} className={fieldClass}>
            {GARAGE_STATUSES.map((value) => <option key={value} value={value}>{STATUS_LABELS[value]}</option>)}
          </select>
        </div>
      </div>
      <ReasonField id={`${id}-reason`} hint="Logged with the change and shown to the garage's owners." />
      <Message state={state} />
      <div><SubmitButton className={buttonClass("primary")}>Save plan and status</SubmitButton></div>
    </form>
  );
}

export function ImpersonateForm({ garageId }: { garageId: string }) {
  const [state, action] = useActionState(startImpersonationAction, idle);
  const id = useId();
  return (
    <form action={action} className="flex flex-col gap-3.5">
      <input type="hidden" name="garageId" value={garageId} />
      <ReasonField id={`${id}-reason`} hint="For example the support ticket. The garage's owners see it." />
      <div>
        <label htmlFor={`${id}-minutes`} className={labelClass}>Minutes</label>
        <input
          id={`${id}-minutes`}
          name="minutes"
          type="number"
          inputMode="numeric"
          min={IMPERSONATION_MIN_MINUTES}
          max={IMPERSONATION_MAX_MINUTES}
          defaultValue={IMPERSONATION_MINUTES}
          required
          className={cn(fieldClass, "max-w-[140px]")}
        />
      </div>
      <Message state={state} />
      <div><SubmitButton className={buttonClass("primary")}>Start read-only session</SubmitButton></div>
    </form>
  );
}

export function RetryJobForm({ jobId, kind }: { jobId: string; kind: string }) {
  const [state, action] = useActionState(retryJobAction, idle);
  const id = useId();
  return (
    <form action={action} className="flex flex-col gap-2.5">
      <input type="hidden" name="jobId" value={jobId} />
      <div>
        <label htmlFor={`${id}-reason`} className={labelClass}>Reason to retry</label>
        <input id={`${id}-reason`} name="reason" required minLength={REASON_MIN} maxLength={REASON_MAX} className={fieldClass} />
      </div>
      <Message state={state} />
      <div><SubmitButton className={buttonClass("secondary", "sm")} aria-label={`Retry ${kind} job`}>Retry job</SubmitButton></div>
    </form>
  );
}

function CodeField({ id }: { id: string }) {
  return (
    <div>
      <label htmlFor={id} className={labelClass}>Verification code</label>
      <input
        id={id}
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        required
        className={cn(fieldClass, "text-center font-mono text-[22px] tracking-[0.3em]")}
      />
    </div>
  );
}

export function PlatformMfaForm({ factorId }: { factorId: string }) {
  const [state, action] = useActionState(verifyPlatformMfaAction, { message: "" });
  const id = useId();
  return (
    <form action={action} className="flex flex-col gap-3.5">
      <input type="hidden" name="factorId" value={factorId} />
      <CodeField id={`${id}-code`} />
      {state.message ? <p role="alert" className="m-0 rounded-input bg-[#fdecec] px-3 py-2.5 text-[14px] font-semibold text-[#991b1b]">{state.message}</p> : null}
      <SubmitButton className={buttonClass("primary")}>Verify</SubmitButton>
    </form>
  );
}

export function PlatformEnrolmentForm() {
  const [enrolment, setEnrolment] = useState<PlatformEnrolment | null>(null);
  const [starting, setStarting] = useState(false);
  if (!enrolment || "error" in enrolment) {
    return (
      <div className="flex flex-col gap-3">
        {enrolment && "error" in enrolment ? <p role="alert" className="m-0 text-[14px] font-semibold text-[#991b1b]">{enrolment.error}</p> : null}
        <button
          type="button"
          className={buttonClass("primary")}
          aria-disabled={starting || undefined}
          onClick={async () => {
            if (starting) return;
            setStarting(true);
            setEnrolment(await startPlatformEnrolmentAction());
            setStarting(false);
          }}
        >
          Set up an authenticator
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3.5">
      {/* eslint-disable-next-line @next/next/no-img-element -- Supabase returns the QR code as an SVG data URL. */}
      <img src={enrolment.qrCode} alt="QR code for your authenticator app" width={180} height={180} className="rounded-input border border-grey-200 bg-white p-2" />
      <p className="m-0 text-[14px]">
        Or enter this key: <code className="font-mono text-[13px] break-all text-navy-950">{enrolment.secret}</code>
      </p>
      <PlatformMfaForm factorId={enrolment.factorId} />
    </div>
  );
}
