"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { Shield } from "lucide-react";
import { PlateInput, StickyActionBar } from "@/components/book";
import { TurnstileField } from "@/components/forms/turnstile-field";
import { initialManageLookupFormState, type ManageLookupFormState } from "@/lib/booking-flow/forms";
import { lookupBookingAction } from "@/lib/booking-flow/manage-actions";
import { FormAlert } from "./booking-screen";
import { manageTextLink } from "./manage-ui";
import { TextField } from "./text-field";
import { PoweredByPitline } from "@/components/brand/powered-by";

const FORM_ID = "manage-lookup-form";

type ManageLookupProps = {
  /** The garage's booking prefix, for the placeholder (`HRM-1234`). */
  bookingPrefix: string;
  /** Why the customer is here instead of on their booking (expired session, link that did not work). */
  notice?: ReactNode;
  /** Show Turnstile (configured for this deployment). */
  humanCheck: boolean;
};

/**
 * Find your booking: reference + registration, POSTed to a server action. Neither is ever put in
 * the address: the form has no GET fallback and the answer is a redirect to `/manage`.
 */
export function ManageLookup({ bookingPrefix, notice, humanCheck }: ManageLookupProps) {
  const [state, formAction, pending] = useActionState<ManageLookupFormState, FormData>(lookupBookingAction, initialManageLookupFormState);
  const [reference, setReference] = useState("");
  const [plate, setPlate] = useState("");
  const [token, setToken] = useState("");
  const handledSeq = useRef(state.seq);

  // After an answer, move focus to the first field to fix (the alert is announced by itself).
  useEffect(() => {
    if (state.seq === handledSeq.current) return;
    handledSeq.current = state.seq;
    if (state.fieldErrors?.reference) document.getElementById("manage-reference")?.focus();
    else if (state.fieldErrors?.registration) document.getElementById("manage-registration")?.focus();
  }, [state]);

  return (
    <>
      <form id={FORM_ID} action={formAction} noValidate className="flex flex-col gap-[18px] px-5 pt-[22px] pb-6">
        <div className="flex flex-col gap-2">
          <h1 className="m-0 font-display text-[38px] leading-[0.98] font-extrabold tracking-[-0.01em] text-navy-950">Find your booking</h1>
          <p className="m-0 text-[15px] leading-normal text-grey-600">
            Enter your booking reference and the car&apos;s registration to see, change or cancel your booking.
          </p>
        </div>

        {notice}

        <TextField
          id="manage-reference"
          name="reference"
          label="Booking reference"
          hint="It's in your confirmation message."
          placeholder={`${bookingPrefix}-1234`}
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          maxLength={12}
          value={reference}
          onChange={(event) => setReference(event.target.value.toUpperCase())}
          error={state.fieldErrors?.reference}
        />

        <PlateInput id="manage-registration" name="registration" value={plate} onChange={setPlate} error={state.fieldErrors?.registration} />

        {humanCheck ? (
          <div>
            <TurnstileField onToken={setToken} />
            <input type="hidden" name="turnstileToken" value={token} />
          </div>
        ) : null}

        {state.message ? <FormAlert>{state.message}</FormAlert> : null}

        <p className="m-0 flex items-center gap-3 text-[14px] leading-[1.4] text-grey-600">
          <Shield size={20} strokeWidth={2} aria-hidden="true" className="shrink-0 text-grey-600" />
          Your registration never appears in links or analytics
        </p>

        <p className="-mt-2 text-[14px] text-grey-600">
          No booking yet?{" "}
          <Link href="/" className={manageTextLink}>
            Book a car in
          </Link>
        </p>
      </form>

      <StickyActionBar type="submit" form={FORM_ID} label={pending ? "Finding your booking" : "Find my booking"} busy={pending} footnote={<PoweredByPitline />} />
    </>
  );
}
