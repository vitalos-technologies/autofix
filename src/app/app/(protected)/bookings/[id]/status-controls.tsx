"use client";

import { useActionState, useId } from "react";
import { ChevronDown } from "lucide-react";
import { buttonClass, StatusPill, SubmitButton } from "@/components/admin-ui";
import { isDestructive, nextStatuses, statusActionLabel } from "@/lib/admin/booking-status";
import type { BookingStatus } from "@/lib/booking-engine/types";
import { cn } from "@/lib/utils";
import { changeBookingStatusFormAction, type BookingActionState } from "../status-actions";

const idle: BookingActionState = { status: "idle", message: "" };

/**
 * The booking's status and the changes staff can make from it (lib/admin/booking-status.ts).
 * Forward steps are buttons; cancelling and no-show sit behind a disclosure with an optional reason.
 */
export function StatusControls({ bookingId, status, reference }: { bookingId: string; status: BookingStatus; reference: string }) {
  const [state, action] = useActionState(changeBookingStatusFormAction, idle);
  const reasonId = useId();
  const next = nextStatuses(status);
  const forward = next.filter((to) => !isDestructive(to));
  const destructive = next.filter(isDestructive);

  return (
    <div className="flex flex-col gap-3.5">
      <p className="m-0 flex flex-wrap items-center gap-2 text-[14px] text-grey-700">
        Now: <StatusPill status={status} />
      </p>

      {next.length === 0 ? (
        <p className="m-0 text-[14px] text-grey-600">
          {status === "collected" ? "This job is finished." : "This booking is closed."} Its status can no longer change.
        </p>
      ) : null}

      {forward.length > 0 ? (
        <form action={action} className="flex flex-wrap gap-2.5">
          <input type="hidden" name="bookingId" value={bookingId} />
          {forward.map((to, index) => (
            <SubmitButton
              key={to}
              name="status"
              value={to}
              className={buttonClass(to === "ready" ? "success" : index === 0 ? "primary" : "secondary", "md", "flex-[1_1_auto]")}
            >
              {statusActionLabel(to, status)}
              <span className="sr-only"> for booking {reference}</span>
            </SubmitButton>
          ))}
        </form>
      ) : null}

      {destructive.length > 0 ? (
        <details className="group rounded-input border border-grey-200">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3.5 text-[14px] font-semibold text-navy-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
            <span className="grow">{destructive.includes("no_show") ? "Cancel or mark a no-show" : status === "requested" ? "Decline this request" : "Cancel this booking"}</span>
            <ChevronDown size={18} strokeWidth={2} aria-hidden="true" className="shrink-0 text-grey-600 transition-transform group-open:rotate-180" />
          </summary>
          <form action={action} className="flex flex-col gap-2.5 border-t border-grey-200 px-3.5 pt-3 pb-3.5">
            <input type="hidden" name="bookingId" value={bookingId} />
            {destructive.includes("cancelled") ? (
              <>
                <label htmlFor={reasonId} className="text-[14px] font-semibold text-grey-800">
                  Reason (optional, the customer is told the booking is cancelled)
                </label>
                <input
                  id={reasonId}
                  name="reason"
                  maxLength={300}
                  autoComplete="off"
                  className="h-11 rounded-input border border-grey-300 px-3 text-[15px] text-navy-950 focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent"
                />
              </>
            ) : null}
            <div className="flex flex-wrap gap-2.5">
              {destructive.map((to) => (
                <SubmitButton
                  key={to}
                  name="status"
                  value={to}
                  className={cn(
                    buttonClass("secondary", "md"),
                    to === "cancelled" && "border-[#b91c1c] text-[#991b1b] hover:border-[#991b1b] hover:bg-[#fdecec]",
                  )}
                >
                  {statusActionLabel(to, status)}
                </SubmitButton>
              ))}
            </div>
          </form>
        </details>
      ) : null}

      <p
        role={state.status === "error" ? "alert" : "status"}
        className={cn(
          "m-0 text-[14px] font-semibold",
          state.status === "error" ? "text-[#991b1b]" : "text-success-ink",
          state.status === "idle" && "sr-only",
        )}
      >
        {state.message}
      </p>
    </div>
  );
}
