"use client";

import { useActionState, useId, useState, type ReactNode } from "react";
import { buttonClass, Panel, SubmitButton } from "@/components/admin-ui";
import { PlateInput, SegmentedControl } from "@/components/book";
import { formatDuration, formatServicePrice, formatSlotLabel } from "@/components/book/format";
import { checkOverrideTime, OVERRIDE_HOURS_HINT, OVERRIDE_MAX_DAYS, OVERRIDE_STEP_MINUTES } from "@/lib/admin/staff-times";
import { addDays } from "@/lib/admin/dates";
import type { LocationMode, PriceMode, ServiceLocationMode } from "@/lib/booking-engine/types";
import { cn } from "@/lib/utils";
import { SlotPicker } from "../_components/slot-picker";
import { AccountChooser, type AccountFill, type ChooserAccount } from "./account-chooser";
import { createStaffBookingAction, getStaffSlotsAction, type StaffBookingState } from "./actions";

export type StaffService = {
  id: string;
  name: string;
  durationMin: number;
  pricePence: number | null;
  priceMode: PriceMode;
  locationMode: ServiceLocationMode;
  /** Offered on the booking page too. Staff can book the others (A178). */
  onlineEnabled: boolean;
};

const idle: StaffBookingState = { status: "idle", message: "" };

const inputClass =
  "h-11 w-full min-w-0 rounded-input border border-grey-300 bg-white px-3 font-sans text-[15px] text-navy-950 focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent aria-invalid:border-[#b91c1c]";
const labelClass = "text-[14px] font-semibold text-grey-800";

function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  children: (describedBy: string | undefined) => ReactNode;
}) {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      {children(describedBy)}
      {hint ? (
        <p id={`${id}-hint`} className="m-0 text-[13px] text-grey-600">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="m-0 text-[13px] font-semibold text-[#991b1b]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The staff booking form: how they booked, the car, the service and time, and the customer. */
export function NewBookingForm({
  services,
  days,
  closedDays,
  timeZone,
  today,
  idempotencyKey,
  accounts = [],
  initialAccountId = null,
}: {
  services: StaffService[];
  days: string[];
  closedDays: string[];
  timeZone: string;
  /** The garage's local date (YYYY-MM-DD): the earliest day for an outside-hours time. */
  today: string;
  idempotencyKey: string;
  /** P5.7: the garage's fleet and trade accounts (Pro), for the optional Account step. */
  accounts?: ChooserAccount[];
  initialAccountId?: string | null;
}) {
  const [state, action] = useActionState(createStaffBookingAction, idle);
  const [source, setSource] = useState<"phone" | "walk_in">("phone");
  const [registration, setRegistration] = useState("");
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [mode, setMode] = useState<LocationMode>("workshop");
  const [startsAt, setStartsAt] = useState<string | null>(null);
  const [overrideHours, setOverrideHours] = useState(false);
  const [freeTime, setFreeTime] = useState("");
  // P5.7: values filled from an account's car or driver; `version` re-mounts the fields with them.
  const [fill, setFill] = useState<AccountFill & { version: number }>({ version: 0 });
  const [poError, setPoError] = useState<string | undefined>(undefined);
  const applyFill = (next: AccountFill) => {
    if (next.registration) setRegistration(next.registration);
    setFill((previous) => ({ ...previous, ...next, version: previous.version + 1 }));
  };
  const id = useId();
  // Outside opening hours (A179): a typed time wins over the grid until a grid time is picked again.
  const free = overrideHours && freeTime ? checkOverrideTime(freeTime, { today, timeZone }) : null;
  const chosen = free ? (free.ok ? free.startsAt : null) : startsAt;
  const freeError = free && !free.ok ? free.error : undefined;
  const errors = state.fieldErrors ?? {};
  const service = services.find((item) => item.id === serviceId) ?? services[0];
  const modes: LocationMode[] = service?.locationMode === "both" ? ["workshop", "mobile"] : [service?.locationMode === "mobile" ? "mobile" : "workshop"];
  const locationMode = modes.includes(mode) ? mode : (modes[0] ?? "workshop");

  return (
    <form
      action={action}
      className="flex flex-col gap-[18px]"
      noValidate
      onSubmit={(event) => {
        // P5.7: an account that needs a PO is checked here first, so a missing PO never costs the
        // rest of the form (React resets a form after its action returns an error).
        const po = event.currentTarget.elements.namedItem("poNumber");
        if (po instanceof HTMLInputElement && po.required && !po.value.trim()) {
          event.preventDefault();
          setPoError("Enter the PO number");
          po.focus();
        } else setPoError(undefined);
      }}
    >
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="source" value={source} />
      <input type="hidden" name="locationMode" value={locationMode} />
      <input type="hidden" name="startsAt" value={chosen ?? ""} />

      {state.status === "error" ? (
        <div role="alert" className="rounded-card border border-[#f3c4c4] bg-[#fdecec] px-4 py-3.5 text-[14px] font-semibold text-[#991b1b]">
          {state.message}
        </div>
      ) : null}

      <div className="flex flex-wrap items-start gap-[18px]">
        <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-[18px]">
          {accounts.length ? <AccountChooser accounts={accounts} initialAccountId={initialAccountId} onFill={applyFill} errors={{ accountId: errors.accountId, poNumber: poError ?? errors.poNumber }} /> : null}

          <Panel title="How did they book?">
            <SegmentedControl
              label="Booking made"
              hideLabel
              options={[
                { value: "phone", label: "On the phone" },
                { value: "walk_in", label: "Walk-in" },
              ]}
              value={source}
              onChange={setSource}
            />
          </Panel>

          <Panel title="The car">
            <PlateInput value={registration} onChange={setRegistration} name="registration" error={errors.registration} id={`${id}-reg`} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id={`${id}-make`} label="Make (optional)">
                {(describedBy) => <input key={`make-${fill.version}`} defaultValue={fill.make} id={`${id}-make`} name="make" autoComplete="off" aria-describedby={describedBy} className={inputClass} />}
              </Field>
              <Field id={`${id}-model`} label="Model (optional)">
                {(describedBy) => <input key={`model-${fill.version}`} defaultValue={fill.model} id={`${id}-model`} name="model" autoComplete="off" aria-describedby={describedBy} className={inputClass} />}
              </Field>
            </div>
          </Panel>

          <Panel title="Service and time">
            <Field id={`${id}-service`} label="Service" error={errors.serviceId}>
              {(describedBy) => (
                <select
                  id={`${id}-service`}
                  name="serviceId"
                  value={serviceId}
                  onChange={(event) => {
                    setServiceId(event.target.value);
                    setStartsAt(null);
                  }}
                  aria-describedby={describedBy}
                  aria-invalid={errors.serviceId ? true : undefined}
                  className={inputClass}
                >
                  {services.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} · {formatDuration(item.durationMin)} · {formatServicePrice(item.pricePence, item.priceMode)}
                      {item.onlineEnabled ? "" : " · not offered online"}
                    </option>
                  ))}
                </select>
              )}
            </Field>

            {modes.length > 1 ? (
              <SegmentedControl
                label="Where?"
                options={[
                  { value: "workshop", label: "At the garage" },
                  { value: "mobile", label: "Mobile visit" },
                ]}
                value={locationMode}
                onChange={(value) => {
                  setMode(value);
                  setStartsAt(null);
                }}
              />
            ) : null}
            {locationMode === "mobile" ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <Field id={`${id}-address`} label="Address" error={errors.address}>
                  {(describedBy) => <input id={`${id}-address`} name="address" autoComplete="off" aria-describedby={describedBy} className={inputClass} />}
                </Field>
                <Field id={`${id}-postcode`} label="Postcode" error={errors.postcode}>
                  {(describedBy) => <input id={`${id}-postcode`} name="postcode" autoComplete="off" aria-describedby={describedBy} className={cn(inputClass, "uppercase")} />}
                </Field>
              </div>
            ) : null}

            <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
              <legend className={cn(labelClass, "mb-2 p-0")}>When</legend>
              <div className="flex flex-col gap-3 rounded-input border border-grey-200 bg-grey-50 p-3">
                <div className="flex flex-col gap-0.5">
                  <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-[15px] font-semibold text-navy-950">
                    <input
                      type="checkbox"
                      name="overrideHours"
                      checked={overrideHours}
                      onChange={(event) => setOverrideHours(event.target.checked)}
                      aria-describedby={`${id}-override-hint`}
                      className="size-5 shrink-0 accent-[var(--garage-accent)]"
                    />
                    Outside opening hours
                  </label>
                  <p id={`${id}-override-hint`} className="m-0 pl-[30px] text-[13px] text-grey-600">
                    {OVERRIDE_HOURS_HINT}
                  </p>
                </div>
                {overrideHours ? (
                  <Field id={`${id}-free-time`} label="Date and time" hint="In the garage's time, on the 5 minutes. Picking a time from the list instead clears this." error={freeError}>
                    {(describedBy) => (
                      <input
                        id={`${id}-free-time`}
                        type="datetime-local"
                        step={OVERRIDE_STEP_MINUTES * 60}
                        min={`${today}T00:00`}
                        max={`${addDays(today, OVERRIDE_MAX_DAYS)}T23:55`}
                        value={freeTime}
                        onChange={(event) => {
                          setFreeTime(event.target.value);
                          if (event.target.value) setStartsAt(null);
                        }}
                        aria-describedby={describedBy}
                        aria-invalid={freeError ? true : undefined}
                        className={cn(inputClass, "sm:max-w-[280px]")}
                      />
                    )}
                  </Field>
                ) : null}
              </div>
              <SlotPicker
                days={days}
                closedDays={closedDays}
                timeZone={timeZone}
                loadSlots={(date) => getStaffSlotsAction(serviceId, date, locationMode)}
                value={free ? null : startsAt}
                onChange={(value) => {
                  setStartsAt(value);
                  setFreeTime("");
                }}
                reloadKey={`${serviceId}:${locationMode}`}
                label="Day"
              />
              {errors.startsAt ? <p className="m-0 text-[13px] font-semibold text-[#991b1b]">{errors.startsAt}</p> : null}
            </fieldset>
          </Panel>
        </div>

        <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-[18px]">
          <Panel title="The customer">
            <Field id={`${id}-name`} label="Name" error={errors.customerName}>
              {(describedBy) => (
                <input key={`name-${fill.version}`} defaultValue={fill.customerName} id={`${id}-name`} name="customerName" autoComplete="off" aria-describedby={describedBy} aria-invalid={errors.customerName ? true : undefined} className={inputClass} />
              )}
            </Field>
            <Field id={`${id}-phone`} label="Mobile" error={errors.customerPhone} hint="Their confirmation and updates go by text.">
              {(describedBy) => (
                <input
                  key={`phone-${fill.version}`}
                  defaultValue={fill.customerPhone}
                  id={`${id}-phone`}
                  name="customerPhone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="off"
                  aria-describedby={describedBy}
                  aria-invalid={errors.customerPhone ? true : undefined}
                  className={inputClass}
                />
              )}
            </Field>
            <Field id={`${id}-email`} label="Email (optional)" error={errors.customerEmail}>
              {(describedBy) => (
                <input key={`email-${fill.version}`} defaultValue={fill.customerEmail} id={`${id}-email`} name="customerEmail" type="email" autoComplete="off" aria-describedby={describedBy} aria-invalid={errors.customerEmail ? true : undefined} className={inputClass} />
              )}
            </Field>
            <label className="flex min-h-11 cursor-pointer items-start gap-2.5 text-[14px] leading-normal text-grey-800">
              <input type="checkbox" name="reminderConsent" className="mt-0.5 size-[18px] shrink-0 accent-[var(--garage-accent)]" />
              <span>The customer agreed to reminders when their MOT and service are due.</span>
            </label>
          </Panel>

          <Panel title="Notes">
            <Field id={`${id}-notes`} label="Anything the workshop should know (optional)">
              {(describedBy) => (
                <textarea
                  id={`${id}-notes`}
                  name="notes"
                  rows={3}
                  maxLength={2000}
                  aria-describedby={describedBy}
                  className="min-h-[88px] w-full rounded-input border border-grey-300 px-3 py-2.5 font-sans text-[15px] leading-normal text-navy-950 focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent"
                />
              )}
            </Field>
          </Panel>

          <SubmitButton className={buttonClass("primary", "md", "min-h-[54px] w-full text-[16px]")}>
            {chosen ? `Book in for ${formatSlotLabel(chosen, timeZone)}` : "Book it in"}
          </SubmitButton>
        </div>
      </div>
    </form>
  );
}
