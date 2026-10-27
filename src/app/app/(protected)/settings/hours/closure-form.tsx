"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { buttonClass, SubmitButton } from "@/components/admin-ui";
import { initialSetupFormState, MAX_CLOSURE_REASON, type ClosureField, type SetupFormState } from "@/lib/settings/setup";
import { FormMessage, TextInputField } from "../_components/fields";
import { addClosureAction } from "./actions";

/** Add a day or a run of days the garage is closed. */
export function ClosureForm({ today }: { today: string }) {
  const [state, formAction] = useActionState<SetupFormState<ClosureField>, FormData>(addClosureAction, initialSetupFormState);
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [reason, setReason] = useState("");
  const [clearedSeq, setClearedSeq] = useState(state.seq);
  const handled = useRef(state.seq);

  // A saved closure empties the form (adjusted while rendering, not in an effect).
  if (state.seq !== clearedSeq) {
    setClearedSeq(state.seq);
    if (state.status === "saved") {
      setStartsOn("");
      setEndsOn("");
      setReason("");
    }
  }

  useEffect(() => {
    if (state.seq === handled.current) return;
    handled.current = state.seq;
    const first = (["startsOn", "endsOn", "reason"] as const).find((field) => state.fieldErrors?.[field]);
    if (first) document.getElementById(`closure-${first}`)?.focus();
  }, [state]);

  return (
    <form action={formAction} noValidate className="flex flex-col gap-3.5 border-t border-[#eef2f6] pt-3.5">
      <h3 className="m-0 font-sans text-[15px] font-bold tracking-normal text-navy-950">Add a closure</h3>
      <div className="grid gap-3.5 sm:grid-cols-2">
        <TextInputField
          id="closure-startsOn"
          name="startsOn"
          type="date"
          label="First day closed"
          min={today}
          value={startsOn}
          onChange={(event) => setStartsOn(event.target.value)}
          error={state.fieldErrors?.startsOn}
        />
        <TextInputField
          id="closure-endsOn"
          name="endsOn"
          type="date"
          label="Last day closed"
          min={startsOn || today}
          value={endsOn}
          onChange={(event) => setEndsOn(event.target.value)}
          error={state.fieldErrors?.endsOn}
          hint="Leave empty for a single day."
        />
      </div>
      <TextInputField
        id="closure-reason"
        name="reason"
        label="Reason (optional)"
        maxLength={MAX_CLOSURE_REASON}
        placeholder="Bank holiday"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        error={state.fieldErrors?.reason}
        hint="For your team. Customers just see the day as unavailable."
      />
      <FormMessage state={state} />
      <SubmitButton className={buttonClass("secondary", "md", "w-full sm:w-fit")}>Add closure</SubmitButton>
    </form>
  );
}
