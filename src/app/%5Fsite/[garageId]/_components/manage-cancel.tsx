"use client";

import Link from "next/link";
import { useActionState, useState, type ReactNode } from "react";
import { StickyActionBar } from "@/components/book";
import { initialManageCancelFormState, type ManageCancelFormState } from "@/lib/booking-flow/forms";
import { cancelBookingAction } from "@/lib/booking-flow/manage-actions";
import { FormAlert } from "./booking-screen";
import { manageTextLink } from "./manage-ui";

const FORM_ID = "manage-cancel-form";
const REASON_MAX_LENGTH = 300;

type ManageCancelProps = {
  /** The booking summary bar (server rendered). */
  summary: ReactNode;
  garageName: string;
};

/** The confirm step before a booking is cancelled, with an optional reason for the garage. */
export function ManageCancel({ summary, garageName }: ManageCancelProps) {
  const [state, formAction, pending] = useActionState<ManageCancelFormState, FormData>(cancelBookingAction, initialManageCancelFormState);
  const [reason, setReason] = useState("");

  return (
    <>
      <form id={FORM_ID} action={formAction} noValidate className="flex flex-col gap-3.5 px-5 pt-[18px] pb-6">
        {summary}
        <div className="mt-1 flex flex-col gap-2">
          <h1 className="m-0 font-display text-[34px] leading-[0.98] font-extrabold text-navy-950">Cancel this booking?</h1>
          <p className="m-0 text-[15px] leading-normal text-grey-600">
            The time will be freed up for someone else. You can book again whenever you&apos;re ready.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="cancel-reason" className="text-[14px] font-semibold text-grey-800">
            Reason <span className="font-normal text-grey-600">(optional)</span>
          </label>
          <textarea
            id="cancel-reason"
            name="reason"
            rows={3}
            maxLength={REASON_MAX_LENGTH}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            aria-describedby="cancel-reason-hint"
            className="min-h-[96px] w-full resize-y rounded-input border border-grey-300 bg-white px-3.5 py-3 font-sans text-[16px] leading-normal text-navy-950 placeholder:text-[#64748b] focus:border-accent focus:ring-1 focus:ring-accent focus:outline-none"
          />
          <p id="cancel-reason-hint" className="m-0 text-[13px] text-grey-600">
            It helps {garageName} plan their day.
          </p>
        </div>

        {state.message ? <FormAlert>{state.message}</FormAlert> : null}

        <Link href="/manage" className={`${manageTextLink} self-center`}>
          Keep my booking
        </Link>
      </form>

      <StickyActionBar type="submit" form={FORM_ID} tone="danger" showArrow={false} label={pending ? "Cancelling" : "Cancel booking"} busy={pending} />
    </>
  );
}
