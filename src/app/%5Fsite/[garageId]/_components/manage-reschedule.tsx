"use client";

import { useActionState, useMemo, useState } from "react";
import { CalendarClock, Clock } from "lucide-react";
import { DateStrip, SlotGrid, StickyActionBar, formatSlotLabel, formatTime, type DateStripDay, type TimeSlot } from "@/components/book";
import { focusRing } from "@/components/book/styles";
import type { LocationMode } from "@/lib/booking-engine/types";
import { dateKeyInZone } from "@/lib/booking-flow/dates";
import { initialManageRescheduleFormState, type ManageRescheduleFormState } from "@/lib/booking-flow/forms";
import { rescheduleBookingAction } from "@/lib/booking-flow/manage-actions";
import { cn } from "@/lib/utils";
import { FormAlert } from "./booking-screen";

const FORM_ID = "manage-reschedule-form";

type ManageRescheduleProps = {
  days: readonly DateStripDay[];
  /** Slots per local date (`YYYY-MM-DD`) for every day in the strip; the booking's own time is marked taken. */
  slotsByDate: Readonly<Record<string, readonly TimeSlot[]>>;
  initialDate: string;
  /** The booking's current start (ISO). */
  currentStart: string;
  timeZone: string;
  locationMode: LocationMode;
  /** Shown instead of the strip when no day has a free time. */
  noTimesMessage: string | null;
};

function sameInstant(a: string | null, b: string | null) {
  return Boolean(a && b) && Date.parse(a!) === Date.parse(b!);
}

/** Pick a new time for an existing booking: the same day strip and slot grid as Book 3. */
export function ManageReschedule({ days, slotsByDate, initialDate, currentStart, timeZone, locationMode, noTimesMessage }: ManageRescheduleProps) {
  const [state, formAction, pending] = useActionState<ManageRescheduleFormState, FormData>(rescheduleBookingAction, initialManageRescheduleFormState);
  const [date, setDate] = useState(initialDate);
  const [start, setStart] = useState<string | null>(null);

  const alternatives = useMemo(
    () => (state.alternatives ?? []).map((slot): TimeSlot => ({ starts_at: slot.startsAt, ends_at: slot.endsAt, free_count: 1 })),
    [state.alternatives],
  );
  const freeSlots = useMemo(
    () => [...Object.values(slotsByDate).flat(), ...alternatives].filter((slot) => slot.free_count > 0 && !sameInstant(slot.starts_at, currentStart)),
    [slotsByDate, alternatives, currentStart],
  );
  // A time that has gone since it was picked (the page re-renders with fresh slots) is dropped.
  const chosen = freeSlots.find((slot) => sameInstant(slot.starts_at, start)) ?? null;
  const daySlots = slotsByDate[date] ?? [];

  function selectDate(next: string) {
    setDate(next);
    // The day is not personal data, so it can live in the address for a reload; nothing else does.
    window.history.replaceState(null, "", `?date=${next}`);
  }

  function selectAlternative(slot: TimeSlot) {
    const day = dateKeyInZone(slot.starts_at, timeZone);
    if (slotsByDate[day]) selectDate(day);
    setStart(slot.starts_at);
  }

  return (
    <>
      <div className="flex flex-col gap-4 pt-5 pb-6">
        <div className="flex items-end justify-between gap-3 px-5">
          <h1 className="m-0 font-display text-[36px] leading-[0.98] font-extrabold text-navy-950">Pick a new time</h1>
          <p className="m-0 flex shrink-0 items-center gap-1.5 pb-1 text-[12px] font-semibold text-success-ink">
            <span aria-hidden="true" className="size-2 rounded-full bg-success" />
            Live from the diary
          </p>
        </div>

        <p className="mx-5 my-0 flex items-center gap-2.5 text-[14px] text-grey-700">
          <CalendarClock size={19} strokeWidth={2} aria-hidden="true" className="shrink-0 text-grey-600" />
          <span>
            Booked now for <strong className="text-navy-950">{formatSlotLabel(currentStart, timeZone)}</strong>
          </span>
        </p>

        {state.message ? (
          <FormAlert className="mx-5">
            <span className="flex flex-col gap-2.5">
              <span>{state.message}</span>
              {alternatives.length > 0 ? (
                <span className="flex flex-col gap-2">
                  <span className="font-normal">These are the nearest free times:</span>
                  <span className="flex flex-wrap gap-2">
                    {alternatives.map((slot) => {
                      const pressed = sameInstant(slot.starts_at, start);
                      return (
                        <button
                          key={slot.starts_at}
                          type="button"
                          aria-pressed={pressed}
                          onClick={() => selectAlternative(slot)}
                          className={cn(
                            "min-h-11 rounded-input border px-3 text-[14px] font-semibold transition-colors",
                            focusRing,
                            pressed ? "border-2 border-accent bg-accent text-accent-ink" : "border-grey-300 bg-white text-navy-950 hover:border-accent",
                          )}
                        >
                          {formatSlotLabel(slot.starts_at, timeZone)}
                        </button>
                      );
                    })}
                  </span>
                </span>
              ) : null}
            </span>
          </FormAlert>
        ) : null}

        {noTimesMessage ? (
          <p className="mx-5 my-0 rounded-control border border-grey-200 bg-white p-3.5 text-[13.5px] leading-[1.45] text-grey-700">{noTimesMessage}</p>
        ) : (
          <>
            <DateStrip days={days} selected={date} onSelect={selectDate} />
            <SlotGrid className="px-5" slots={daySlots} selected={chosen?.starts_at ?? null} onSelect={setStart} timeZone={timeZone} />
          </>
        )}

        <div aria-live="polite" className="px-5">
          {chosen ? (
            <div className="mt-1 flex items-start gap-3 rounded-control border border-[#e0e7ef] bg-white p-3.5">
              <Clock size={20} strokeWidth={2} aria-hidden="true" className="mt-px shrink-0 text-grey-600" />
              <p className="m-0 text-[13.5px] leading-[1.45] text-grey-700">
                {locationMode === "mobile" ? (
                  <>
                    We&apos;ll come to you at <strong className="text-navy-950">{formatTime(chosen.starts_at, timeZone)}</strong>.
                  </>
                ) : (
                  <>
                    Drop off at <strong className="text-navy-950">{formatTime(chosen.starts_at, timeZone)}</strong>.
                  </>
                )}
                {chosen.ends_at ? ` Expected ${locationMode === "mobile" ? "finished" : "ready"} around ${formatTime(chosen.ends_at, timeZone)}.` : ""}{" "}
                Your current time stays booked until you move it.
              </p>
            </div>
          ) : null}
        </div>
      </div>

      <form id={FORM_ID} action={formAction}>
        <input type="hidden" name="startsAt" value={chosen?.starts_at ?? ""} />
      </form>
      <StickyActionBar
        type="submit"
        form={FORM_ID}
        label={chosen ? `Move to ${formatSlotLabel(chosen.starts_at, timeZone)}` : "Choose a new time"}
        disabled={!chosen}
        busy={pending}
        footnote="We'll send you the new time."
      />
    </>
  );
}
