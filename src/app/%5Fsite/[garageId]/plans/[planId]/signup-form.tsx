"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { SegmentedControl, StickyActionBar } from "@/components/book";
import { TurnstileField } from "@/components/forms/turnstile-field";
import type { CustomerChannel } from "@/lib/booking-engine/types";
import { CHANNEL_OPTIONS } from "@/lib/booking-flow/copy";
import { cn } from "@/lib/utils";
import { FormAlert } from "../../_components/booking-screen";
import { TextField } from "../../_components/text-field";
import { startPlanSignupAction, type PlanSignupState } from "../actions";

const FORM_ID = "plan-signup-form";
const FIELDS = ["name", "phone", "email", "registration", "authorise"] as const;

/**
 * The sign-up form (P5.11): who you are, your car, the Direct Debit Guarantee and the account
 * holder's authorisation. Posts to startPlanSignupAction(); the registration travels in the form body
 * only, never in a URL.
 */
export function PlanSignupForm({
  planId,
  priceLabel,
  payee,
  guarantee,
  humanCheck,
  testMode,
}: {
  planId: string;
  priceLabel: string;
  payee: string;
  guarantee: string[];
  humanCheck: boolean;
  testMode: boolean;
}) {
  const [state, formAction, pending] = useActionState<PlanSignupState, FormData>(startPlanSignupAction, { seq: 0 });
  const [channel, setChannel] = useState<CustomerChannel>("sms");
  const [token, setToken] = useState("");
  const handledSeq = useRef(state.seq);

  useEffect(() => {
    if (state.seq === handledSeq.current) return;
    handledSeq.current = state.seq;
    const first = FIELDS.find((field) => state.fieldErrors?.[field]);
    if (first) document.getElementById(`plan-${first}`)?.focus();
  }, [state]);

  const authoriseError = state.fieldErrors?.authorise;

  return (
    <>
      <form id={FORM_ID} action={formAction} noValidate className="flex flex-col gap-3.5">
        <input type="hidden" name="planId" value={planId} />
        <h2 className="m-0 mt-2 font-sans text-[18px] font-bold text-navy-950">Your details</h2>
        <TextField id="plan-name" name="name" label="Full name" autoComplete="name" maxLength={120} error={state.fieldErrors?.name} />
        <TextField id="plan-phone" name="phone" label="Mobile number" type="tel" inputMode="tel" autoComplete="tel" placeholder="07700 900000" maxLength={30} error={state.fieldErrors?.phone} />
        <TextField
          id="plan-email"
          name="email"
          label="Email"
          labelNote="(for your Direct Debit notices)"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@example.com"
          maxLength={254}
          error={state.fieldErrors?.email}
        />
        <SegmentedControl label="Messages by" variant="outline" options={CHANNEL_OPTIONS} value={channel} onChange={setChannel} />
        <input type="hidden" name="channel" value={channel} />

        <h2 className="m-0 mt-2 font-sans text-[18px] font-bold text-navy-950">Your car</h2>
        <TextField
          id="plan-registration"
          name="registration"
          label="Registration"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="AB12 CDE"
          maxLength={10}
          className="[&_input]:uppercase"
          error={state.fieldErrors?.registration}
        />
        <div className="grid grid-cols-2 gap-3">
          <TextField id="plan-make" name="make" label="Make" labelNote="(optional)" autoComplete="off" maxLength={80} />
          <TextField id="plan-model" name="model" label="Model" labelNote="(optional)" autoComplete="off" maxLength={120} />
        </div>

        <section aria-labelledby="dd-guarantee-title" className="mt-2 flex flex-col gap-2 rounded-card border border-grey-300 bg-white p-4">
          <h2 id="dd-guarantee-title" className="m-0 font-sans text-[16px] font-bold text-navy-950">
            The Direct Debit Guarantee
          </h2>
          <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-[13.5px] leading-normal text-grey-800">
            {guarantee.map((paragraph) => (
              <li key={paragraph}>{paragraph}</li>
            ))}
          </ul>
        </section>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-start gap-3">
            <input
              id="plan-authorise"
              name="authorise"
              type="checkbox"
              value="yes"
              aria-invalid={authoriseError ? true : undefined}
              aria-describedby={authoriseError ? "plan-authorise-error" : undefined}
              className="mt-3 size-5 shrink-0 accent-accent"
            />
            <label htmlFor="plan-authorise" className="min-h-11 py-2 text-[14px] leading-normal text-grey-800">
              I&apos;m the account holder and the only person needed to authorise Direct Debits from this account. I ask {payee} to collect {priceLabel} by Direct
              Debit each month until I cancel.
            </label>
          </div>
          {authoriseError ? (
            <p id="plan-authorise-error" className="m-0 text-[13px] font-semibold text-[#b91c1c]">
              {authoriseError}
            </p>
          ) : null}
        </div>

        {humanCheck ? (
          <div>
            <TurnstileField onToken={setToken} />
            <input type="hidden" name="turnstileToken" value={token} />
          </div>
        ) : null}
        {testMode ? (
          <p className={cn("m-0 rounded-card border border-dashed border-grey-300 bg-white px-3 py-2.5 text-[13px] leading-normal text-grey-700")}>
            Test mode: no bank details are taken and no money moves.
          </p>
        ) : null}
        {state.message ? <FormAlert>{state.message}</FormAlert> : null}
      </form>
      <StickyActionBar
        type="submit"
        form={FORM_ID}
        label="Set up Direct Debit"
        showArrow={false}
        busy={pending}
        className="pt-3"
        footnote={
          <>
            {testMode ? "You confirm on the next page." : "You enter your bank details on our payment provider's secure page."}{" "}
            <Link href="/privacy" className="text-grey-700 underline underline-offset-2 hover:text-navy-950">
              How we use your details
            </Link>
          </>
        }
      />
    </>
  );
}
