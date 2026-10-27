"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { focusRing } from "@/components/book/styles";
import { unsubscribeFormAction } from "@/lib/consent/actions";
import { initialUnsubscribeFormState, type UnsubscribeFormState } from "@/lib/consent/forms";
import { cn } from "@/lib/utils";
import { FormAlert } from "./booking-screen";
import { TextField } from "./text-field";

type UnsubscribeFormProps = {
  /** The generic answer, garage name filled ("If that number is on our list…"). */
  doneMessage: string;
};

const errorMessages: Partial<Record<UnsubscribeFormState["status"], string>> = {
  invalid_phone: "Enter a UK mobile number, for example 07700 900123.",
  rate_limited: "Too many tries. Please wait a few minutes, or reply STOP to any reminder text.",
  unavailable: "We couldn't do that just now. Please try again, or reply STOP to any reminder text.",
};

/** Opt out by mobile number (no link). The answer never says whether the number was on file. */
export function UnsubscribeForm({ doneMessage }: UnsubscribeFormProps) {
  const [state, formAction, pending] = useActionState<UnsubscribeFormState, FormData>(unsubscribeFormAction, initialUnsubscribeFormState);
  const [phone, setPhone] = useState("");
  const answerRef = useRef<HTMLDivElement>(null);
  const handledSeq = useRef(state.seq);

  useEffect(() => {
    if (state.seq === handledSeq.current) return;
    handledSeq.current = state.seq;
    if (state.status === "invalid_phone") document.getElementById("unsubscribe-phone")?.focus();
    else answerRef.current?.focus();
  }, [state]);

  if (state.status === "done") {
    return (
      <div ref={answerRef} tabIndex={-1} role="status" className="rounded-control border border-grey-200 bg-white px-3.5 py-3 text-[15px] leading-normal text-grey-800 outline-none">
        {doneMessage}
      </div>
    );
  }

  const message = errorMessages[state.status];
  return (
    <form action={formAction} noValidate className="flex flex-col gap-3.5">
      <TextField
        id="unsubscribe-phone"
        name="phone"
        label="Mobile number"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        placeholder="07700 900000"
        maxLength={30}
        required
        value={phone}
        onChange={(event) => setPhone(event.target.value)}
        error={state.status === "invalid_phone" ? message : undefined}
      />
      {message && state.status !== "invalid_phone" ? (
        <div ref={answerRef} tabIndex={-1} className="outline-none">
          <FormAlert>{message}</FormAlert>
        </div>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        aria-busy={pending || undefined}
        className={cn(
          "inline-flex h-[54px] w-full cursor-pointer items-center justify-center rounded-control border-0 bg-accent px-4 text-[16px] font-bold text-accent-ink disabled:cursor-wait disabled:opacity-70",
          focusRing,
        )}
      >
        {pending ? "Stopping reminders…" : "Stop reminders"}
      </button>
    </form>
  );
}
