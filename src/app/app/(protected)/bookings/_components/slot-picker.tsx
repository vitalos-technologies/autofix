"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { LoaderCircle } from "lucide-react";
import { DateStrip, SlotGrid, type TimeSlot } from "@/components/book";

export type SlotLoadResult = { ok: boolean; message?: string; slots: TimeSlot[] };

export type SlotPickerProps = {
  /** Local dates to offer (`YYYY-MM-DD`), today first. */
  days: readonly string[];
  /** Days the garage is closed (shown, but not pickable). */
  closedDays?: readonly string[];
  timeZone: string;
  /** Loads one day's times (a server action through the booking engine). */
  loadSlots: (date: string) => Promise<SlotLoadResult>;
  /** Chosen start (ISO), controlled by the parent. */
  value: string | null;
  onChange: (startsAt: string | null) => void;
  /** Changing this (e.g. the service) reloads the selected day. */
  reloadKey?: string;
  label?: string;
};

/** Book 3's day strip and slot grid, for staff: pick a day, then a free time. */
export function SlotPicker({ days, closedDays = [], timeZone, loadSlots, value, onChange, reloadKey = "", label = "Choose a day" }: SlotPickerProps) {
  const [date, setDate] = useState<string | null>(days.find((day) => !closedDays.includes(day)) ?? days[0] ?? null);
  const [slots, setSlots] = useState<TimeSlot[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const request = useRef(0);
  const load = useRef(loadSlots);
  const change = useRef(onChange);

  useEffect(() => {
    load.current = loadSlots;
    change.current = onChange;
  });

  useEffect(() => {
    if (!date) return;
    const ticket = ++request.current;
    change.current(null);
    startTransition(async () => {
      const result = await load.current(date).catch(() => ({ ok: false, message: "Times could not be loaded. Please try again.", slots: [] as TimeSlot[] }));
      if (ticket !== request.current) return;
      setSlots(result.slots);
      setMessage(result.ok ? null : (result.message ?? "Times could not be loaded."));
    });
  }, [date, reloadKey]);

  return (
    <div className="flex flex-col gap-3">
      <DateStrip days={days.map((day) => ({ date: day, disabled: closedDays.includes(day) }))} selected={date} onSelect={setDate} label={label} disabledLabel="closed" />
      <div aria-live="polite" aria-busy={pending}>
        {pending ? (
          <p className="m-0 flex items-center gap-2 text-[14px] text-grey-600">
            <LoaderCircle size={18} strokeWidth={2} aria-hidden="true" className="animate-spin" />
            Finding free times…
          </p>
        ) : message ? (
          <p role="alert" className="m-0 rounded-input border border-[#f3c4c4] bg-[#fdecec] px-3.5 py-3 text-[14px] font-semibold text-[#991b1b]">
            {message}
          </p>
        ) : (
          <SlotGrid slots={slots} selected={value} onSelect={(startsAt) => onChange(startsAt)} timeZone={timeZone} emptyMessage="No free times on this day. Try another day." />
        )}
      </div>
    </div>
  );
}
