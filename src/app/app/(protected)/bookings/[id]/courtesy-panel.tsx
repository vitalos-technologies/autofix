import { Truck } from "lucide-react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Badge, buttonClass, Panel } from "@/components/admin-ui";
import { formatTimeRange } from "@/components/admin-ui/format";
import { formatShortDate } from "@/components/book/format";
import { PlateChip } from "@/components/book/plate-chip";
import { courtesyInputClass, courtesySummaryClass, CourtesyNotice, FieldLabel, LoanItem } from "@/components/courtesy/courtesy-ui";
import { ProBadge } from "@/components/plans/pro-locked";
import { CourtesyDataError, loadBookingCourtesy, loadCarOptions, type CarOption } from "@/lib/courtesy/server";
import { courtesyFlash, LEG_LABELS, localInputValue } from "@/lib/courtesy/view";
import { garageHasFeature } from "@/lib/plans/server";
import type { Garage } from "@/lib/tenancy/garage";
import { cn } from "@/lib/utils";
import {
  checkInAction,
  checkOutAction,
  declineRequestAction,
  holdCollectionAction,
  releaseCollectionAction,
  releaseLoanAction,
  reserveCarAction,
} from "../../courtesy-cars/actions";

type Props = {
  client: SupabaseClient;
  garage: Garage;
  booking: { id: string; status: string; locationMode: "workshop" | "mobile"; postcode: string | null };
  timeZone: string;
  flash: { done?: string; error?: string };
};

const FINISHED = new Set(["cancelled", "no_show", "collected"]);

/**
 * P5.8 on the booking page: the courtesy car (request, reserve from the free cars for the booking's
 * day, check out / in) and collection and delivery with the van. Pro only; an Essentials garage that
 * once used it sees what is there, read-only.
 */
export async function CourtesyBookingPanel({ client, garage, booking, timeZone, flash }: Props) {
  const enabled = garageHasFeature(garage, "courtesy_cars");
  let data;
  try {
    data = await loadBookingCourtesy(client, garage.id, booking.id);
  } catch (error) {
    if (!(error instanceof CourtesyDataError)) throw error;
    return null;
  }
  const hasData = data.loans.length > 0 || data.legs.length > 0 || data.request !== null;
  if (!enabled && !hasData) return null;

  const live = !FINISHED.has(booking.status);
  const returnTo = `/app/bookings/${booking.id}`;
  const liveLoan = data.loans.find((loan) => loan.status === "reserved" || loan.status === "out") ?? null;
  const carNames = new Map(data.cars.map((car) => [car.id, car]));
  let options: CarOption[] = [];
  if (enabled && live && !liveLoan && data.cars.some((car) => car.active)) {
    try {
      options = await loadCarOptions(client, booking.id);
    } catch {
      options = [];
    }
  }
  const window = options[0] ? { startsAt: options[0].windowStarts, endsAt: options[0].windowEnds } : null;
  const offersCollection = enabled && data.serviceOffersCollection && booking.locationMode === "workshop";
  const notice = courtesyFlash(flash.done, flash.error);
  const actions = { release: releaseLoanAction, checkOut: checkOutAction, checkIn: checkInAction };
  const firstLeg = data.legs[0] ?? null;

  return (
    <Panel
      id="courtesy"
      title={
        <span className="inline-flex items-center gap-2">
          Courtesy car and collection
          {!enabled ? <ProBadge /> : null}
        </span>
      }
    >
      <CourtesyNotice flash={notice} />

      {data.request?.status === "open" ? (
        <div className="flex flex-wrap items-center gap-3 rounded-input bg-warning-bg px-3.5 py-3 text-[14px] text-warning-ink">
          <p className="m-0 min-w-0 flex-[1_1_200px] font-semibold">The customer asked for a courtesy car. Choose one below, or decline.</p>
          {enabled ? (
            <form action={declineRequestAction}>
              <input type="hidden" name="requestId" value={data.request.id} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <button type="submit" className={buttonClass("secondary", "sm", "min-h-11")}>
                Decline request
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
      {data.request?.status === "declined" && !liveLoan ? <p className="m-0 text-[14px] text-grey-700">The customer&apos;s courtesy car request was declined.</p> : null}

      <section aria-labelledby="courtesy-car-title" className="flex flex-col gap-2">
        <h3 id="courtesy-car-title" className="m-0 font-sans text-[12px] font-bold tracking-[0.06em] text-grey-600 uppercase">
          Courtesy car
        </h3>
        {data.loans.map((loan) => {
          const car = carNames.get(loan.carId);
          return (
            <div key={loan.id} className="flex flex-col">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-[15px] font-bold text-navy-950">{car?.name ?? "Courtesy car"}</span>
                {car ? <PlateChip registration={car.registration} /> : null}
              </span>
              <LoanItem
                loan={loan}
                carName={car?.name ?? "the car"}
                timeZone={timeZone}
                returnTo={returnTo}
                actions={actions}
                canAct={enabled}
                showBooking={false}
                currentMileage={car?.mileage}
              />
            </div>
          );
        })}

        {enabled && live && !liveLoan ? (
          data.cars.some((car) => car.active) ? (
            <form action={reserveCarAction} className="flex flex-col gap-3">
              <input type="hidden" name="bookingId" value={booking.id} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
                <legend className="mb-1.5 p-0 text-[14px] font-semibold text-grey-800">
                  Add courtesy car
                  {window ? (
                    <span className="block font-normal text-grey-600">
                      Free on {formatShortDate(window.startsAt, timeZone)}, {formatTimeRange(window.startsAt, window.endsAt, timeZone)} (drop-off to closing)
                    </span>
                  ) : null}
                </legend>
                {options.map((option, index) => (
                  <label
                    key={option.carId}
                    className={cn(
                      "flex min-h-11 items-center gap-3 rounded-input border px-3 py-2 text-[14.5px]",
                      option.free ? "cursor-pointer border-grey-300 bg-white has-[:checked]:border-2 has-[:checked]:border-accent" : "cursor-not-allowed border-grey-200 bg-grey-50 text-grey-700",
                      "has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-solid",
                    )}
                  >
                    <input
                      type="radio"
                      name="carId"
                      value={option.carId}
                      disabled={!option.free}
                      defaultChecked={option.free && options.findIndex((candidate) => candidate.free) === index}
                      className="size-5 accent-accent"
                    />
                    <span className="font-semibold text-navy-950">{option.name}</span>
                    <PlateChip registration={option.registration} />
                    <span className="ml-auto text-[13px]">{option.free ? "Free" : "Lent then"}</span>
                  </label>
                ))}
              </fieldset>
              {window ? (
                <details>
                  <summary className={courtesySummaryClass}>Different times</summary>
                  <div className="mt-2 grid gap-3 rounded-input bg-grey-50 p-3 sm:grid-cols-2">
                    <div className="flex flex-col gap-1.5">
                      <FieldLabel htmlFor="courtesy-from">From</FieldLabel>
                      <input id="courtesy-from" name="from" type="datetime-local" defaultValue={localInputValue(window.startsAt, timeZone)} className={courtesyInputClass} />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <FieldLabel htmlFor="courtesy-until">Until</FieldLabel>
                      <input id="courtesy-until" name="until" type="datetime-local" defaultValue={localInputValue(window.endsAt, timeZone)} className={courtesyInputClass} />
                    </div>
                  </div>
                </details>
              ) : null}
              <button type="submit" disabled={!options.some((option) => option.free)} className={buttonClass("primary", "md", "w-full sm:w-fit")}>
                Reserve courtesy car
              </button>
              {!options.some((option) => option.free) ? <p className="m-0 text-[13px] text-grey-600">Every car is lent for some of that day.</p> : null}
            </form>
          ) : (
            <p className="m-0 text-[14px] text-grey-600">No courtesy cars set up yet. Add them on the Courtesy cars page.</p>
          )
        ) : null}
        {!liveLoan && data.loans.length === 0 && (!enabled || !live) ? <p className="m-0 text-[14px] text-grey-600">No courtesy car on this booking.</p> : null}
      </section>

      {offersCollection || data.legs.length > 0 ? (
        <section aria-labelledby="collection-title" className="flex flex-col gap-2 border-t border-[#f1f5f9] pt-3.5">
          <h3 id="collection-title" className="m-0 font-sans text-[12px] font-bold tracking-[0.06em] text-grey-600 uppercase">
            Collection and delivery
          </h3>
          {data.legs.length > 0 ? (
            <>
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {data.legs.map((leg) => (
                  <li key={leg.id} className="flex flex-wrap items-center gap-2 text-[14px]">
                    <Truck size={16} strokeWidth={2} aria-hidden="true" className="text-grey-600" />
                    <span className="font-bold text-navy-950">
                      {LEG_LABELS[leg.leg]} {formatShortDate(leg.startsAt, timeZone)}, {formatTimeRange(leg.startsAt, leg.endsAt, timeZone)}
                    </span>
                    {leg.status === "held" ? <Badge tone="info">{leg.resourceName ?? "Van"}</Badge> : <Badge tone="warning">No van free: arrange by phone</Badge>}
                  </li>
                ))}
              </ul>
              {firstLeg ? (
                <p className="m-0 text-[14px] text-grey-700">
                  {[firstLeg.address, firstLeg.postcode].filter(Boolean).join(", ")}
                </p>
              ) : null}
              {enabled && live ? (
                <div className="flex flex-wrap items-start gap-x-3">
                  {data.legs.some((leg) => leg.status === "unassigned") && firstLeg ? (
                    <form action={holdCollectionAction}>
                      <input type="hidden" name="bookingId" value={booking.id} />
                      <input type="hidden" name="returnTo" value={returnTo} />
                      <input type="hidden" name="collectionPostcode" value={firstLeg.postcode} />
                      <input type="hidden" name="collectionAddress" value={firstLeg.address ?? firstLeg.postcode} />
                      <button type="submit" className={buttonClass("secondary", "sm", "min-h-11")}>
                        Try the van again
                      </button>
                    </form>
                  ) : null}
                  <form action={releaseCollectionAction}>
                    <input type="hidden" name="bookingId" value={booking.id} />
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <button type="submit" className={buttonClass("ghost", "sm", "min-h-11")}>
                      Cancel collection and delivery
                    </button>
                  </form>
                </div>
              ) : null}
            </>
          ) : live ? (
            <form action={holdCollectionAction} className="flex flex-col gap-3">
              <input type="hidden" name="bookingId" value={booking.id} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <p className="m-0 text-[14px] text-grey-700">We collect the car before the job and bring it back after. The van is held for both runs.</p>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
                <div className="flex flex-col gap-1.5">
                  <FieldLabel htmlFor="collection-address">Address</FieldLabel>
                  <input id="collection-address" name="collectionAddress" autoComplete="off" maxLength={300} required className={courtesyInputClass} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <FieldLabel htmlFor="collection-postcode">Postcode</FieldLabel>
                  <input
                    id="collection-postcode"
                    name="collectionPostcode"
                    autoComplete="off"
                    maxLength={10}
                    required
                    defaultValue={booking.postcode ?? undefined}
                    className={cn(courtesyInputClass, "uppercase")}
                  />
                </div>
              </div>
              <button type="submit" className={buttonClass("secondary", "md", "w-full sm:w-fit")}>
                Book collection and delivery
              </button>
            </form>
          ) : null}
        </section>
      ) : null}
    </Panel>
  );
}
