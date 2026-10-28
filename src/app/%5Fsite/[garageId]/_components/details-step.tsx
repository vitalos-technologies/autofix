"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { ConsentCheckbox, SegmentedControl, StickyActionBar } from "@/components/book";
import { TurnstileField } from "@/components/forms/turnstile-field";
import type { CustomerChannel } from "@/lib/booking-engine/types";
import { confirmBookingAction } from "@/lib/booking-flow/actions";
import { CHANNEL_OPTIONS } from "@/lib/booking-flow/copy";
import { initialDetailsFormState, type DetailsFormState } from "@/lib/booking-flow/forms";
import { BookingExtrasFields } from "./booking-extras";
import type { BookingExtrasOptions } from "@/lib/courtesy/booking-site";
import { FormAlert } from "./booking-screen";
import { TextField } from "./text-field";

const FORM_ID = "details-form";

type DetailsStepProps = {
  /** The booking-so-far bar (server rendered). */
  summary: ReactNode;
  /** Picks the consent wording (MOT and service, or service only). */
  motEnabled: boolean;
  /** The garage checks this booking before confirming it. */
  needsApproval: boolean;
  humanCheck: boolean;
  /** P5.8: courtesy car request / collection and delivery offered for this slot (Pro garages). */
  extras?: BookingExtrasOptions;
};

/** Step 4: who is bringing the car, how to send updates, reminder consent, Confirm booking. */
export function DetailsStep({ summary, motEnabled, needsApproval, humanCheck, extras }: DetailsStepProps) {
  const [state, formAction, pending] = useActionState<DetailsFormState, FormData>(confirmBookingAction, initialDetailsFormState);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [channel, setChannel] = useState<CustomerChannel>("sms");
  const [consent, setConsent] = useState(false);
  const [token, setToken] = useState("");
  const handledSeq = useRef(state.seq);

  useEffect(() => {
    if (state.seq === handledSeq.current) return;
    handledSeq.current = state.seq;
    const first = (["name", "phone", "email"] as const).find((field) => state.fieldErrors?.[field]);
    if (first) document.getElementById(`customer-${first}`)?.focus();
    else if (state.fieldErrors?.collectionAddress) document.getElementById("collection-address")?.focus();
    else if (state.fieldErrors?.collectionPostcode) document.getElementById("collection-postcode")?.focus();
  }, [state]);

  return (
    <>
      <form id={FORM_ID} action={formAction} noValidate className="flex flex-col gap-3.5 px-5 pt-[18px]">
        {summary}
        <h1 className="mt-1 mb-0 font-display text-[34px] leading-[0.98] font-extrabold text-navy-950">Who&apos;s dropping it off?</h1>

        <TextField
          id="customer-name"
          name="name"
          label="Full name"
          autoComplete="name"
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={state.fieldErrors?.name}
        />
        <TextField
          id="customer-phone"
          name="phone"
          label="Mobile number"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="07700 900000"
          maxLength={30}
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          error={state.fieldErrors?.phone}
        />
        <TextField
          id="customer-email"
          name="email"
          label="Email"
          labelNote={channel === "email" ? "(for updates and your receipt)" : "(for your receipt)"}
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@example.com"
          maxLength={254}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={state.fieldErrors?.email}
        />

        <SegmentedControl label="Updates by" variant="outline" options={CHANNEL_OPTIONS} value={channel} onChange={setChannel} />
        <input type="hidden" name="channel" value={channel} />

        {extras && (extras.courtesy || extras.collection) ? (
          <BookingExtrasFields offered={extras} errors={{ postcode: state.fieldErrors?.collectionPostcode, address: state.fieldErrors?.collectionAddress }} />
        ) : null}

        <ConsentCheckbox name="reminderConsent" value="yes" checked={consent} onCheckedChange={setConsent} motEnabled={motEnabled} />

        {needsApproval ? (
          <p className="m-0 text-[13px] leading-[1.45] text-grey-600">The garage checks this kind of job first and will confirm the time with you.</p>
        ) : null}

        {humanCheck ? (
          <div>
            <TurnstileField onToken={setToken} />
            <input type="hidden" name="turnstileToken" value={token} />
          </div>
        ) : null}

        {state.message ? (
          <FormAlert>
            {state.message}
            {state.editHref ? (
              <>
                {" "}
                <Link href={state.editHref} className="text-[#991b1b] underline underline-offset-2">
                  {state.editLabel ?? "Go back"}
                </Link>
              </>
            ) : null}
          </FormAlert>
        ) : null}
      </form>
      <StickyActionBar
        type="submit"
        form={FORM_ID}
        label="Confirm booking"
        showArrow={false}
        busy={pending}
        className="pt-3"
        footnote={
          <>
            Nothing to pay now.{" "}
            <Link href="/privacy" className="text-grey-700 underline underline-offset-2 hover:text-navy-950">
              How we use your details
            </Link>
          </>
        }
      />
    </>
  );
}
