"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { LoaderCircle } from "lucide-react";
import { buttonClass } from "@/components/admin-ui";
import { formatSlotLabel } from "@/components/book/format";
import { cn } from "@/lib/utils";
import { SlotPicker, type SlotLoadResult } from "../_components/slot-picker";
import { getAdminBookingSlotsAction, rescheduleAdminBookingAction } from "../actions";

/**
 * Move a booking to another free time ("Offer another time" lands here). The booking engine keeps
 * its bay when free, else another of the same kind, and tells the customer. Dragging on the diary
 * comes later; this is the way to move a booking for now.
 */
export function RescheduleControls({
  bookingId,
  currentStart,
  timeZone,
  days,
  closedDays,
}: {
  bookingId: string;
  currentStart: string;
  timeZone: string;
  days: readonly string[];
  closedDays?: readonly string[];
}) {
  const router = useRouter();
  const [chosen, setChosen] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function loadSlots(date: string): Promise<SlotLoadResult> {
    const result = await getAdminBookingSlotsAction(bookingId, date, date);
    return {
      ok: result.success,
      message: result.message,
      slots: (result.slots ?? []).map((slot) => ({ starts_at: slot.start, ends_at: slot.end, free_count: 1 })),
    };
  }

  function move() {
    if (!chosen) return;
    setMessage(null);
    startTransition(async () => {
      const result = await rescheduleAdminBookingAction(bookingId, chosen).catch(() => ({ success: false, message: "The booking could not be moved. Please try again." }));
      setMessage({ tone: result.success ? "success" : "error", text: result.message });
      setConfirming(false);
      if (result.success) {
        setChosen(null);
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col gap-3.5">
      <p className="m-0 text-[14px] text-grey-700">
        Now: <strong className="text-navy-950">{formatSlotLabel(currentStart, timeZone)}</strong>. Pick a new day and time; the customer is told.
      </p>
      <SlotPicker
        days={days}
        closedDays={closedDays}
        timeZone={timeZone}
        loadSlots={loadSlots}
        value={chosen}
        onChange={(value) => {
          setChosen(value);
          setConfirming(false);
        }}
        label="Day to move the booking to"
      />
      {chosen && !confirming ? (
        <button type="button" onClick={() => setConfirming(true)} className={buttonClass("primary", "md", "self-start")}>
          Move to {formatSlotLabel(chosen, timeZone)}
        </button>
      ) : null}
      {chosen && confirming ? (
        <div role="group" aria-label="Confirm the move" className="flex flex-col gap-2.5 rounded-input border border-grey-200 bg-grey-50 p-3.5">
          <p className="m-0 text-[14px] text-grey-800">
            Move this booking to <strong>{formatSlotLabel(chosen, timeZone)}</strong> and tell the customer?
          </p>
          <div className="flex flex-wrap gap-2.5">
            <button type="button" onClick={move} disabled={pending} className={buttonClass("primary")}>
              {pending ? <LoaderCircle size={18} strokeWidth={2} aria-hidden="true" className="animate-spin" /> : null}
              Yes, move it
            </button>
            <button type="button" onClick={() => setConfirming(false)} disabled={pending} className={buttonClass("secondary")}>
              Keep the current time
            </button>
          </div>
        </div>
      ) : null}
      {message ? (
        <p role={message.tone === "error" ? "alert" : "status"} className={cn("m-0 text-[14px] font-semibold", message.tone === "error" ? "text-[#991b1b]" : "text-success-ink")}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
