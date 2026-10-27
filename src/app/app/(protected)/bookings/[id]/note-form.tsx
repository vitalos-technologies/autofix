"use client";

import { useActionState, useEffect, useId, useRef } from "react";
import { buttonClass, SubmitButton } from "@/components/admin-ui";
import { cn } from "@/lib/utils";
import { addBookingNoteAction, type BookingActionState } from "../status-actions";

const idle: BookingActionState = { status: "idle", message: "" };

/** "Add a note" on the booking timeline (a `booking_events` note, written as the member). */
export function NoteForm({ bookingId }: { bookingId: string }) {
  const [state, action] = useActionState(addBookingNoteAction, idle);
  const form = useRef<HTMLFormElement>(null);
  const fieldId = useId();
  const messageId = useId();

  useEffect(() => {
    if (state.status === "done") form.current?.reset();
  }, [state]);

  return (
    <form ref={form} action={action} className="flex flex-col gap-2">
      <input type="hidden" name="bookingId" value={bookingId} />
      <label htmlFor={fieldId} className="text-[14px] font-semibold text-grey-800">
        Add a note
      </label>
      <textarea
        id={fieldId}
        name="note"
        rows={3}
        maxLength={1000}
        aria-describedby={messageId}
        className="min-h-[88px] w-full rounded-input border border-grey-300 px-3 py-2.5 font-sans text-[15px] leading-normal text-navy-950 focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent"
      />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton className={buttonClass("secondary")}>Add note</SubmitButton>
        <p
          id={messageId}
          role={state.status === "error" ? "alert" : "status"}
          className={cn("m-0 text-[14px] font-semibold", state.status === "error" ? "text-[#991b1b]" : "text-success-ink")}
        >
          {state.message || <span className="font-normal text-grey-600">Only your team sees notes.</span>}
        </p>
      </div>
    </form>
  );
}
