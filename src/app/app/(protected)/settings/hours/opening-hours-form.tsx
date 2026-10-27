"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { buttonClass, Panel, SubmitButton } from "@/components/admin-ui";
import { cn } from "@/lib/utils";
import {
  checkDayWindows,
  formatClock,
  initialSetupFormState,
  MAX_WINDOWS_PER_DAY,
  normaliseTime,
  WEEKDAYS,
  type HoursField,
  type SetupFormState,
} from "@/lib/settings/setup";
import { FormMessage, inputClass } from "../_components/fields";
import { saveOpeningHoursAction } from "./actions";

type Row = { key: number; opens: string; closes: string };
export type WeekWindows = Record<number, Array<{ opens: string; closes: string }>>;

let nextKey = 1;
const withKeys = (windows: WeekWindows) =>
  Object.fromEntries(WEEKDAYS.map(({ day }) => [day, (windows[day] ?? []).map((window) => ({ key: nextKey++, ...window }))])) as Record<number, Row[]>;

/** The weekly opening windows: several per day for a split day, none for closed. */
export function OpeningHoursForm({ initial, canEdit }: { initial: WeekWindows; canEdit: boolean }) {
  const [state, formAction] = useActionState<SetupFormState<HoursField>, FormData>(saveOpeningHoursAction, initialSetupFormState);
  const [week, setWeek] = useState<Record<number, Row[]>>(() => withKeys(initial));
  const handled = useRef(state.seq);

  useEffect(() => {
    if (state.seq === handled.current) return;
    handled.current = state.seq;
    const first = WEEKDAYS.find(({ day }) => state.fieldErrors?.[`day-${day}`]);
    if (first) document.getElementById(`hours-day-${first.day}`)?.focus();
  }, [state]);

  const update = (day: number, rows: Row[]) => setWeek((current) => ({ ...current, [day]: rows }));

  return (
    <Panel id="opening-hours" title="Opening hours">
      <p className="m-0 text-[14px] text-grey-600">
        Customers can book start times inside these hours. Add a second set for a split day, such as a lunch break.
      </p>
      <form action={formAction} noValidate className="flex flex-col gap-4">
        <fieldset disabled={!canEdit} className="m-0 flex min-w-0 flex-col border-0 p-0">
          <legend className="sr-only">Weekly opening hours</legend>
          {WEEKDAYS.map(({ day, name }) => {
            const rows = week[day] ?? [];
            const serverError = state.fieldErrors?.[`day-${day}`];
            const liveError = rows.every((row) => normaliseTime(row.opens) && normaliseTime(row.closes)) ? checkDayWindows(name, rows) : null;
            const error = serverError ?? liveError;
            const errorId = `hours-day-${day}-error`;
            return (
              <div
                key={day}
                id={`hours-day-${day}`}
                tabIndex={-1}
                role="group"
                aria-labelledby={`hours-day-${day}-name`}
                aria-describedby={error ? errorId : undefined}
                className="flex flex-col gap-2 border-t border-[#eef2f6] py-3 outline-none first:border-t-0 sm:flex-row sm:items-start sm:gap-4"
              >
                <div className="flex min-h-11 items-center justify-between gap-3 sm:w-[120px] sm:shrink-0">
                  <span id={`hours-day-${day}-name`} className="text-[15px] font-bold text-navy-950">
                    {name}
                  </span>
                  {rows.length === 0 ? <span className="text-[14px] text-grey-600 sm:hidden">Closed</span> : null}
                </div>
                <div className="flex min-w-0 grow flex-col gap-2">
                  {rows.length === 0 ? <span className="hidden min-h-11 items-center text-[14px] text-grey-600 sm:flex">Closed</span> : null}
                  {rows.map((row, index) => (
                    <div key={row.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_44px] items-end gap-2 sm:max-w-[420px]">
                      <label className="flex min-w-0 flex-col gap-1">
                        <span className="text-[12.5px] font-semibold text-grey-700">Opens</span>
                        <input
                          type="time"
                          name={`opens-${day}`}
                          step={300}
                          required
                          value={row.opens}
                          aria-invalid={error ? true : undefined}
                          onChange={(event) => update(day, rows.map((item) => (item.key === row.key ? { ...item, opens: event.target.value } : item)))}
                          className={cn(inputClass, "px-2.5 tabular-nums", error ? "border-2 border-[#b91c1c]" : "border-grey-300")}
                        />
                      </label>
                      <label className="flex min-w-0 flex-col gap-1">
                        <span className="text-[12.5px] font-semibold text-grey-700">Closes</span>
                        <input
                          type="time"
                          name={`closes-${day}`}
                          step={300}
                          required
                          value={row.closes}
                          aria-invalid={error ? true : undefined}
                          onChange={(event) => update(day, rows.map((item) => (item.key === row.key ? { ...item, closes: event.target.value } : item)))}
                          className={cn(inputClass, "px-2.5 tabular-nums", error ? "border-2 border-[#b91c1c]" : "border-grey-300")}
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => update(day, rows.filter((item) => item.key !== row.key))}
                        aria-label={`Remove ${name} ${describe(row)}${rows.length > 1 ? ` (set ${index + 1})` : ""}`}
                        className={buttonClass("secondary", "sm", "w-11 shrink-0 px-0")}
                      >
                        <X size={18} strokeWidth={2} aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                  {error ? (
                    <p id={errorId} className="m-0 text-[13px] font-semibold text-[#b91c1c]">
                      {error}
                    </p>
                  ) : null}
                  {canEdit && rows.length < MAX_WINDOWS_PER_DAY ? (
                    <button
                      type="button"
                      onClick={() => update(day, [...rows, defaultRow(rows)])}
                      className={buttonClass("ghost", "sm", "w-fit gap-1.5 px-2 text-accent")}
                    >
                      <Plus size={18} strokeWidth={2} aria-hidden="true" />
                      {rows.length ? "Add more hours" : "Open this day"}
                      <span className="sr-only"> on {name}</span>
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </fieldset>
        <FormMessage state={state} />
        {canEdit ? (
          <SubmitButton className={buttonClass("primary", "md", "w-full sm:w-fit")}>Save opening hours</SubmitButton>
        ) : null}
      </form>
    </Panel>
  );
}

function describe(row: Row) {
  const opens = normaliseTime(row.opens);
  const closes = normaliseTime(row.closes);
  return opens && closes ? `${formatClock(opens)} to ${formatClock(closes)}` : "hours";
}

/** A new window: after the day's last one (an afternoon after a morning), else 8am to 5:30pm. */
function defaultRow(rows: Row[]): Row {
  const last = rows.at(-1);
  const lastClose = last ? normaliseTime(last.closes) : null;
  if (lastClose && lastClose < "22:00") {
    const [hours = "0", minutes = "0"] = lastClose.split(":");
    const start = Number(hours) * 60 + Number(minutes) + 60;
    const end = Math.min(start + 240, 23 * 60 + 55);
    const clock = (total: number) => `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
    return { key: nextKey++, opens: clock(start), closes: clock(end) };
  }
  return { key: nextKey++, opens: "08:00", closes: "17:30" };
}
