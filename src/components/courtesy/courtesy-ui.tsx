import Link from "next/link";
import type { ReactNode } from "react";
import { CarFront, CircleAlert, CircleCheck } from "lucide-react";
import { Badge, buttonClass, focusRing, textLinkClass, type BadgeTone } from "@/components/admin-ui";
import { formatTimeRange } from "@/components/admin-ui/format";
import { formatShortDate } from "@/components/book/format";
import type { FormAction } from "@/components/admin-ui/types";
import { cn } from "@/lib/utils";
import { FUEL_OPTIONS, fuelLabel, formatMiles, LOAN_STATUS_LABELS, MAX_CAR_NAME, MAX_CAR_NOTES, type CourtesyCar, type CourtesyLoan, type LoanStatus } from "@/lib/courtesy/view";

// P5.8 building blocks shared by /app/courtesy-cars and the booking page's courtesy panel.
// Server-compatible: plain forms posting to server actions, `<details>` for the inline forms, so
// everything works without JavaScript. 44px targets, real labels.

const inputClass = cn(
  "h-11 w-full min-w-0 rounded-input border border-grey-300 bg-white px-3 font-sans text-[15px] text-navy-950",
  "focus-visible:border-2 focus-visible:border-accent focus-visible:outline-none",
);
const labelClass = "text-[14px] font-semibold text-grey-800";
const summaryClass = cn(
  "inline-flex min-h-11 cursor-pointer list-none items-center rounded-input px-1 text-[14px] font-semibold text-accent-text underline underline-offset-2 [&::-webkit-details-marker]:hidden",
  focusRing,
);

export const LOAN_TONES: Record<LoanStatus, BadgeTone> = { reserved: "info", out: "warning", returned: "success", cancelled: "muted" };

/** The flash line under the page header (done: status, error: alert). */
export function CourtesyNotice({ flash, className }: { flash: { tone: "success" | "error"; text: string } | null; className?: string }) {
  if (!flash) return null;
  const success = flash.tone === "success";
  return (
    <div
      role={success ? "status" : "alert"}
      className={cn(
        "flex items-start gap-2 rounded-card px-4 py-3.5 text-[14px] font-semibold",
        success ? "border border-[#bfe5cb] bg-success-bg text-success-ink" : "border border-[#f3c4c4] bg-[#fdecec] text-[#991b1b]",
        className,
      )}
    >
      {success ? <CircleCheck size={18} strokeWidth={2} aria-hidden="true" className="mt-px shrink-0" /> : <CircleAlert size={18} strokeWidth={2} aria-hidden="true" className="mt-px shrink-0" />}
      <span>{flash.text}</span>
    </div>
  );
}

/** Small "Courtesy car" chip for booking cards (Today, Diary). */
export function CourtesyCarChip({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full bg-[#e8f0fb] px-2 py-0.5 text-[11.5px] font-bold text-[#1e40af]", className)}>
      <CarFront size={12} strokeWidth={2.4} aria-hidden="true" />
      Courtesy car
    </span>
  );
}

function Hidden({ fields }: { fields: Record<string, string> }) {
  return (
    <>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

/** Mileage + fuel (+ notes) for check-out and check-in. */
export function LoanReadingForm({
  idPrefix,
  action,
  fields,
  submitLabel,
  notesLabel,
  defaultMileage,
}: {
  idPrefix: string;
  action: FormAction;
  fields: Record<string, string>;
  submitLabel: string;
  notesLabel: string;
  defaultMileage?: number | null;
}) {
  return (
    <form action={action} className="mt-2 flex flex-col gap-3 rounded-input bg-grey-50 p-3">
      <Hidden fields={fields} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${idPrefix}-mileage`} className={labelClass}>
            Mileage
          </label>
          <input
            id={`${idPrefix}-mileage`}
            name="mileage"
            inputMode="numeric"
            autoComplete="off"
            required
            defaultValue={defaultMileage ?? undefined}
            className={inputClass}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${idPrefix}-fuel`} className={labelClass}>
            Fuel
          </label>
          <select id={`${idPrefix}-fuel`} name="fuel" required defaultValue="" className={inputClass}>
            <option value="" disabled>
              Choose
            </option>
            {FUEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${idPrefix}-notes`} className={labelClass}>
          {notesLabel} <span className="font-normal text-grey-600">(optional)</span>
        </label>
        <textarea id={`${idPrefix}-notes`} name="notes" rows={2} maxLength={1000} className={cn(inputClass, "h-auto py-2.5")} />
      </div>
      <button type="submit" className={buttonClass("primary", "md", "w-full sm:w-fit")}>
        {submitLabel}
      </button>
    </form>
  );
}

export type LoanActions = { release: FormAction; checkOut: FormAction; checkIn: FormAction };

/** One loan: when, booking, status, and the next step (check out / release, or check in). */
export function LoanItem({
  loan,
  carName,
  timeZone,
  returnTo,
  actions,
  canAct,
  showBooking = true,
  currentMileage,
}: {
  loan: CourtesyLoan;
  carName: string;
  timeZone: string;
  returnTo: string;
  actions: LoanActions;
  canAct: boolean;
  showBooking?: boolean;
  currentMileage?: number | null;
}) {
  const fields = { loanId: loan.id, returnTo };
  const sameDay = formatShortDate(loan.startsAt, timeZone) === formatShortDate(new Date(Date.parse(loan.endsAt) - 1), timeZone);
  const when = sameDay
    ? `${formatShortDate(loan.startsAt, timeZone)}, ${formatTimeRange(loan.startsAt, loan.endsAt, timeZone)}`
    : `${formatShortDate(loan.startsAt, timeZone)} to ${formatShortDate(loan.endsAt, timeZone)}`;
  return (
    <div className="flex flex-col gap-1.5 border-t border-[#f1f5f9] py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="text-[14.5px] font-bold text-navy-950">{when}</span>
        <Badge tone={LOAN_TONES[loan.status]}>{LOAN_STATUS_LABELS[loan.status]}</Badge>
      </div>
      {showBooking ? (
        <p className="m-0 text-[14px] text-grey-700">
          <Link href={`/app/bookings/${loan.bookingId}`} className={cn(textLinkClass, "text-[14px]")}>
            {loan.reference ?? "Booking"}
          </Link>
          {loan.customerName ? ` · ${loan.customerName}` : null}
        </p>
      ) : null}
      {loan.status === "out" || loan.status === "returned" ? (
        <p className="m-0 text-[13px] text-grey-600">
          Out: {formatMiles(loan.mileageOut)}, fuel {fuelLabel(loan.fuelOut).toLowerCase()}
          {loan.status === "returned" ? ` · Back: ${formatMiles(loan.mileageIn)}, fuel ${fuelLabel(loan.fuelIn).toLowerCase()}` : null}
        </p>
      ) : null}
      {loan.damageNotes ? <p className="m-0 text-[13px] text-[#991b1b]">Damage: {loan.damageNotes}</p> : null}
      {canAct && loan.status === "reserved" ? (
        <div className="flex flex-wrap items-start gap-x-3">
          <details className="group min-w-0 flex-[1_1_240px]">
            <summary className={summaryClass}>
              Check out <span className="sr-only">{carName}</span>
            </summary>
            <LoanReadingForm
              idPrefix={`out-${loan.id}`}
              action={actions.checkOut}
              fields={fields}
              submitLabel={`Hand over ${carName}`}
              notesLabel="Notes"
              defaultMileage={currentMileage}
            />
          </details>
          <form action={actions.release}>
            <Hidden fields={fields} />
            <button type="submit" className={buttonClass("ghost", "sm", "min-h-11")}>
              Release <span className="sr-only">{carName}</span>
            </button>
          </form>
        </div>
      ) : null}
      {canAct && loan.status === "out" ? (
        <details className="group">
          <summary className={summaryClass}>
            Check in <span className="sr-only">{carName}</span>
          </summary>
          <LoanReadingForm idPrefix={`in-${loan.id}`} action={actions.checkIn} fields={fields} submitLabel={`Take back ${carName}`} notesLabel="Damage or problems" />
        </details>
      ) : null}
    </div>
  );
}

/** Name, registration, notes, mileage and fuel: add or edit a car (owners and managers). */
export function CarFields({ idPrefix, car }: { idPrefix: string; car?: CourtesyCar }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${idPrefix}-name`} className={labelClass}>
          Name
        </label>
        <input id={`${idPrefix}-name`} name="name" required maxLength={MAX_CAR_NAME} autoComplete="off" placeholder="Fiesta" defaultValue={car?.name} className={inputClass} />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${idPrefix}-registration`} className={labelClass}>
          Registration
        </label>
        <input
          id={`${idPrefix}-registration`}
          name="registration"
          required
          maxLength={10}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="AB12 CDE"
          defaultValue={car?.registration}
          className={cn(inputClass, "uppercase")}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${idPrefix}-mileage`} className={labelClass}>
          Mileage <span className="font-normal text-grey-600">(optional)</span>
        </label>
        <input id={`${idPrefix}-mileage`} name="mileage" inputMode="numeric" autoComplete="off" defaultValue={car?.mileage ?? undefined} className={inputClass} />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${idPrefix}-fuel`} className={labelClass}>
          Fuel <span className="font-normal text-grey-600">(optional)</span>
        </label>
        <select id={`${idPrefix}-fuel`} name="fuel" defaultValue={car?.fuelEighths ?? ""} className={inputClass}>
          <option value="">Not recorded</option>
          {FUEL_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <label htmlFor={`${idPrefix}-notes`} className={labelClass}>
          Notes <span className="font-normal text-grey-600">(optional)</span>
        </label>
        <textarea id={`${idPrefix}-notes`} name="notes" rows={2} maxLength={MAX_CAR_NOTES} defaultValue={car?.notes ?? undefined} className={cn(inputClass, "h-auto py-2.5")} />
      </div>
    </div>
  );
}

export function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className={labelClass}>
      {children}
    </label>
  );
}

export { inputClass as courtesyInputClass, summaryClass as courtesySummaryClass };
