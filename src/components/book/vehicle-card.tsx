import { Car, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { DEFAULT_GARAGE_TIME_ZONE, formatCalendarDate, formatMileage, localDateKey, parseCalendarDate } from "./format";

export type VehicleCardProps = {
  make: string;
  model?: string | null;
  year?: number | null;
  /** Engine description, e.g. size and fuel. */
  engine?: string | null;
  colour?: string | null;
  /** The garage's `mot_enabled`. The MOT chip is never shown when false. */
  motEnabled: boolean;
  /** `vehicles.mot_expiry` (`YYYY-MM-DD`). */
  motExpiry?: string | null;
  /** Last recorded mileage, in miles. */
  lastMileage?: number | null;
  /** Shows the accent border and tick. */
  selected?: boolean;
  /** Today, for the "due soon" / "expired" MOT colour. Defaults to now. */
  now?: Date;
  timeZone?: string;
  className?: string;
};

type MotState = "ok" | "soon" | "expired";

const SOON_DAYS = 30;
const DAY_MS = 86_400_000;

function motState(due: Date, now: Date, timeZone: string): MotState {
  const today = parseCalendarDate(localDateKey(now, timeZone));
  if (!today) return "ok";
  const days = Math.round((due.getTime() - today.getTime()) / DAY_MS);
  if (days < 0) return "expired";
  if (days <= SOON_DAYS) return "soon";
  return "ok";
}

const chip = "rounded-full px-[9px] py-1 text-[12px] font-semibold";

/** The car found from the registration: make and model, year · engine · colour, MOT and mileage chips. */
export function VehicleCard({
  make,
  model,
  year,
  engine,
  colour,
  motEnabled,
  motExpiry,
  lastMileage,
  selected = false,
  now,
  timeZone = DEFAULT_GARAGE_TIME_ZONE,
  className,
}: VehicleCardProps) {
  const title = [make, model].filter((part) => part && part.trim()).join(" ");
  const details = [year ? String(year) : null, engine, colour].filter((part) => part && String(part).trim()).join(" · ");
  const motDue = motEnabled ? parseCalendarDate(motExpiry) : null;
  const motText = motDue && motExpiry ? formatCalendarDate(motExpiry, timeZone) : "";
  const mot = motDue && motText ? motState(motDue, now ?? new Date(), timeZone) : null;
  const showMileage = typeof lastMileage === "number" && Number.isFinite(lastMileage) && lastMileage > 0;

  return (
    <div
      data-selected={selected ? "true" : "false"}
      className={cn(
        "flex items-start gap-3.5 rounded-card bg-white p-4 font-sans leading-[normal]",
        selected ? "border-[1.5px] border-accent" : "border border-grey-200",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="flex size-11 shrink-0 items-center justify-center rounded-input bg-[color-mix(in_srgb,var(--garage-accent)_9%,white)] text-navy-950"
      >
        <Car size={22} strokeWidth={2} />
      </span>
      <div className="flex min-w-0 grow flex-col gap-1">
        <p className="m-0 text-[16px] font-bold text-navy-950">{title}</p>
        {details ? <p className="m-0 text-[13px] text-grey-600">{details}</p> : null}
        {mot || showMileage ? (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {mot ? (
              <span
                data-testid="vehicle-mot"
                className={cn(chip, mot === "ok" ? "bg-success-bg text-success-ink" : "bg-warning-bg text-warning-ink")}
              >
                {mot === "expired" ? `MOT expired ${motText}` : `MOT due ${motText}`}
              </span>
            ) : null}
            {showMileage ? <span className={cn(chip, "bg-grey-100 text-grey-700")}>Last mileage {formatMileage(lastMileage)}</span> : null}
          </div>
        ) : null}
      </div>
      {selected ? (
        <span className="shrink-0 text-accent">
          <Check size={22} strokeWidth={2} aria-hidden="true" />
          <span className="sr-only">Selected</span>
        </span>
      ) : null}
    </div>
  );
}
