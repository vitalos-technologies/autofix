"use client";

import { useActionState, useMemo, useState } from "react";
import { Clock } from "lucide-react";
import { DateStrip, SlotGrid, StickyActionBar, formatSlotLabel, formatTime, type DateStripDay, type TimeSlot } from "@/components/book";
import { focusRing } from "@/components/book/styles";
import type { LocationMode } from "@/lib/booking-engine/types";
import { timeStepAction } from "@/lib/booking-flow/actions";
import { dateKeyInZone } from "@/lib/booking-flow/dates";
import { initialTimeFormState, type TimeFormState } from "@/lib/booking-flow/forms";
import { cn } from "@/lib/utils";
import { FormAlert } from "./booking-screen";

const FORM_ID = "time-form";

type TimeStepProps = {
  days: readonly DateStripDay[];
  /** Slots per local date (`YYYY-MM-DD`) for every day in the strip. */
  slotsByDate: Readonly<Record<string, readonly TimeSlot[]>>;
  initialDate: string;
  /** The start already in the draft, when it is still free. */
  initialStart: string | null;
  timeZone: string;
  locationMode: LocationMode;
  /** The engine said the time picked had gone: nearest free times to offer instead. */
  slotTaken: { startsAt: string; alternatives: readonly TimeSlot[] } | null;
  /** Shown instead of the strip when no day has a free time. */
  noTimesMessage: string | null;
};

function sameInstant(a: string | null, b: string | null) {
  return Boolean(a && b) && Date.parse(a!) === Date.parse(b!);
}

/** Step 3: day strip, times for the day, and the drop-off note. */
export function TimeStep({ days, slotsByDate, initialDate, initialStart, timeZone, locationMode, slotTaken, noTimesMessage }: TimeStepProps) {
  const [state, formAction, pending] = useActionState<TimeFormState, FormData>(timeStepAction, initialTimeFormState);
  const [date, setDate] = useState(initialDate);
  const [start, setStart] = useState<string | null>(initialStart);

  const freeSlots = useMemo(() => {
    const all = [...Object.values(slotsByDate).flat(), ...(slotTaken?.alternatives ?? [])];
    return all.filter((slot) => slot.free_count > 0);
  }, [slotsByDate, slotTaken]);
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
      <div className="flex flex-col gap-4 pt-5">
        <div className="flex items-end justify-between gap-3 px-5">
          <h1 className="m-0 font-display text-[36px] leading-[0.98] font-extrabold text-navy-950">Pick a time</h1>
          <p className="m-0 flex shrink-0 items-center gap-1.5 pb-1 text-[12px] font-semibold text-success-ink">
            <span aria-hidden="true" className="size-2 rounded-full bg-success" />
            Live from the diary
          </p>
        </div>

        {slotTaken ? (
          <div role="alert" className="mx-5 flex flex-col gap-2.5 rounded-control border border-[#f0d9a1] bg-warning-bg p-3.5 text-warning-ink">
            <p className="m-0 text-[13.5px] leading-[1.45] font-semibold">
              Sorry, {formatSlotLabel(slotTaken.startsAt, timeZone)} has just been booked by someone else.
              {slotTaken.alternatives.length > 0 ? " These are the nearest free times:" : " Choose another time below."}
            </p>
            {slotTaken.alternatives.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {slotTaken.alternatives.map((slot) => {
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
              </div>
            ) : null}
          </div>
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
                We&apos;ll let you know when it&apos;s done.
              </p>
            </div>
          ) : null}
        </div>

        {state.message ? <FormAlert className="mx-5">{state.message}</FormAlert> : null}
      </div>

      <form id={FORM_ID} action={formAction}>
        <input type="hidden" name="startsAt" value={chosen?.starts_at ?? ""} />
      </form>
      <StickyActionBar
        type="submit"
        form={FORM_ID}
        label={chosen ? formatSlotLabel(chosen.starts_at, timeZone) : "Choose a time"}
        disabled={!chosen}
        busy={pending}
      />
    </>
  );
}
