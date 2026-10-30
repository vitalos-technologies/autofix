import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarDays, CarFront, ChevronLeft, ChevronRight, Truck } from "lucide-react";
import { Badge, buttonClass, EmptyState, PageHeader, Panel, Switch, textLinkClass } from "@/components/admin-ui";
import { formatDateKey, formatTimeRange } from "@/components/admin-ui/format";
import { formatShortDate } from "@/components/book/format";
import { PlateChip } from "@/components/book/plate-chip";
import { CarFields, courtesySummaryClass, CourtesyNotice, LoanItem } from "@/components/courtesy/courtesy-ui";
import { ProLockedPage } from "@/components/plans/pro-locked";
import { addDays, localDateKey, parseDateKey, startOfLocalDay, weekStart } from "@/lib/admin/dates";
import {
  CourtesyDataError,
  loadFleet,
  loadLiveLoans,
  loadLoansBetween,
  loadOpenRequests,
  loadUpcomingLegs,
} from "@/lib/courtesy/server";
import { CAR_STATE_LABELS, courtesyFlash, formatMiles, fuelLabel, LEG_LABELS, shapeFleetWeek, type CarWeek, type CourtesyLoan } from "@/lib/courtesy/view";
import { garageHasFeature } from "@/lib/plans/server";
import { canManageSetup } from "@/lib/settings/setup";
import { getAdminContext } from "@/lib/tenancy/admin";
import { cn } from "@/lib/utils";
import {
  addCarAction,
  checkInAction,
  checkOutAction,
  declineRequestAction,
  deleteCarAction,
  releaseLoanAction,
  setCarActiveAction,
  updateCarAction,
} from "./actions";

export const metadata: Metadata = { title: "Courtesy cars" };

type PageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const STATE_TONES: Record<CarWeek["state"], "warning" | "info" | "success" | "muted"> = { out: "warning", reserved_today: "info", free: "success", off: "muted" };

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Courtesy cars (P5.8, Pro): the fleet with a week of loans per car, check out / check in with
 * mileage and fuel, customer requests waiting for a car, and the van's collection and delivery
 * runs. Phone first: one card per car; desktop: two columns of cards beside the side panels.
 */
export default async function CourtesyCarsPage({ searchParams }: PageProps) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  const query = await searchParams;
  const timeZone = admin.garage.timezone || "Europe/London";
  const now = new Date();
  const today = localDateKey(now, timeZone);
  const monday = weekStart(parseDateKey(first(query.week)) ?? today);
  const thisMonday = weekStart(today);
  const returnTo = monday === thisMonday ? "/app/courtesy-cars" : `/app/courtesy-cars?week=${monday}`;
  const from = startOfLocalDay(monday, timeZone).toISOString();
  const to = startOfLocalDay(addDays(monday, 7), timeZone).toISOString();
  const enabled = garageHasFeature(admin.garage, "courtesy_cars");
  const canManage = canManageSetup(admin.role);
  const flash = courtesyFlash(first(query.courtesy), first(query.courtesyError));

  let loaded;
  try {
    loaded = await Promise.all([
      loadFleet(admin.client, admin.garage.id),
      loadLoansBetween(admin.client, admin.garage.id, from, to),
      loadLiveLoans(admin.client, admin.garage.id),
      enabled ? loadOpenRequests(admin.client, admin.garage.id) : Promise.resolve([]),
      enabled ? loadUpcomingLegs(admin.client, admin.garage.id, startOfLocalDay(today, timeZone).toISOString(), 30) : Promise.resolve([]),
    ]);
  } catch (error) {
    if (!(error instanceof CourtesyDataError)) throw error;
    loaded = null;
  }

  if (!enabled) {
    return (
      <div className="flex flex-col gap-5 pb-10">
        <ProLockedPage feature="courtesy_cars" title="Courtesy cars" canUpgrade={admin.role === "owner"} hasExistingData={(loaded?.[0].length ?? 0) > 0} />
        {loaded && loaded[0].length > 0 ? (
          <Panel title="Your courtesy cars" padding="flush">
            <ul className="m-0 list-none p-0">
              {loaded[0].map((car) => (
                <li key={car.id} className="flex flex-wrap items-center gap-2.5 border-t border-[#f1f5f9] py-3 first:border-t-0">
                  <span className="text-[15px] font-bold text-navy-950">{car.name}</span>
                  <PlateChip registration={car.registration} />
                  <span className="text-[13px] text-grey-600">{formatMiles(car.mileage)}</span>
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}
      </div>
    );
  }

  const header = (
    <PageHeader
      eyebrow="Grow"
      title="Courtesy cars"
      description="Lend a car with a job, and collect and deliver customers' cars with the van. A car is never lent twice at once."
    />
  );

  if (!loaded) {
    return (
      <div className="flex flex-col gap-5 pb-10">
        {header}
        <div role="alert" className="rounded-card border border-[#f3c4c4] bg-[#fdecec] px-4 py-3.5 text-[14px] font-semibold text-[#991b1b]">
          The courtesy cars could not be loaded. Refresh the page to try again.
        </div>
      </div>
    );
  }

  const [cars, weekLoans, liveLoans, requests, legs] = loaded;
  // Loans shown: this week's, plus any car still out from before (it has not come back).
  const shownLoans: CourtesyLoan[] = [...weekLoans, ...liveLoans.filter((loan) => loan.status === "out" && !weekLoans.some((week) => week.id === loan.id))];
  const fleet = shapeFleetWeek(cars, shownLoans, monday, timeZone, now);
  const unassigned = legs.filter((leg) => leg.status === "unassigned");
  const actions = { release: releaseLoanAction, checkOut: checkOutAction, checkIn: checkInAction };
  const weekLabel = `${formatDateKey(monday)} to ${formatDateKey(addDays(monday, 6))}`;

  return (
    <div className="flex flex-col gap-5 pb-10">
      {header}
      <CourtesyNotice flash={flash} />

      <nav aria-label="Weeks" className="flex flex-wrap items-center gap-2.5">
        <Link href={`/app/courtesy-cars?week=${addDays(monday, -7)}`} className={buttonClass("secondary", "md")}>
          <ChevronLeft size={18} strokeWidth={2} aria-hidden="true" />
          Previous week
        </Link>
        {monday !== thisMonday ? (
          <Link href="/app/courtesy-cars" className={buttonClass("secondary", "md")}>
            <CalendarDays size={18} strokeWidth={2} aria-hidden="true" />
            This week
          </Link>
        ) : null}
        <Link href={`/app/courtesy-cars?week=${addDays(monday, 7)}`} className={buttonClass("secondary", "md")}>
          Next week
          <ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
        </Link>
        <p className="m-0 text-[14px] font-semibold text-grey-700">{weekLabel}</p>
      </nav>

      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-5">
          {requests.length > 0 || unassigned.length > 0 ? (
            <Panel id="needs-ok" title="Needs your OK" count={requests.length + unassigned.length} countLabel={`${requests.length + unassigned.length} to sort out`}>
              <ul className="m-0 flex list-none flex-col p-0">
                {requests.map((request) => (
                  <li key={request.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-[#f1f5f9] py-3 first:border-t-0">
                    <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-0.5">
                      <span className="text-[14.5px] font-bold text-navy-950">Courtesy car asked for{request.customerName ? ` by ${request.customerName}` : ""}</span>
                      <span className="text-[13px] text-grey-600">
                        {request.reference ?? "Booking"}
                        {request.startsAt ? ` · ${formatShortDate(request.startsAt, timeZone)}` : null}
                        {request.freeAtRequest ? " · a car was free when they booked" : " · no car was free when they booked"}
                      </span>
                    </div>
                    <Link href={`/app/bookings/${request.bookingId}#courtesy`} className={buttonClass("primary", "sm", "min-h-11")}>
                      Choose a car <span className="sr-only">for {request.reference}</span>
                    </Link>
                    <form action={declineRequestAction}>
                      <input type="hidden" name="requestId" value={request.id} />
                      <input type="hidden" name="returnTo" value={returnTo} />
                      <button type="submit" className={buttonClass("ghost", "sm", "min-h-11")}>
                        Decline <span className="sr-only">courtesy car for {request.reference}</span>
                      </button>
                    </form>
                  </li>
                ))}
                {unassigned.map((leg) => (
                  <li key={leg.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-[#f1f5f9] py-3 first:border-t-0">
                    <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-0.5">
                      <span className="text-[14.5px] font-bold text-navy-950">
                        {LEG_LABELS[leg.leg]} needs a van{leg.customerName ? `: ${leg.customerName}` : ""}
                      </span>
                      <span className="text-[13px] text-grey-600">
                        {leg.reference ?? "Booking"} · {formatShortDate(leg.startsAt, timeZone)}, {formatTimeRange(leg.startsAt, leg.endsAt, timeZone)} · {leg.postcode}
                      </span>
                    </div>
                    <Link href={`/app/bookings/${leg.bookingId}#courtesy`} className={buttonClass("secondary", "sm", "min-h-11")}>
                      Open booking <span className="sr-only">{leg.reference}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          <section aria-labelledby="fleet-title" className="flex flex-col gap-3">
            <h2 id="fleet-title" className="m-0 font-sans text-[17px] font-bold text-navy-950">
              Your cars this week
            </h2>
            {fleet.length === 0 ? (
              <EmptyState
                tone="card"
                icon={CarFront}
                title="No courtesy cars yet"
                description={canManage ? "Add the cars you lend to customers. Then lend one from any booking." : "Ask the owner or a manager to add the cars you lend."}
              />
            ) : (
              <ul className="m-0 grid list-none gap-3 p-0 xl:grid-cols-2">
                {fleet.map((row) => (
                  <li key={row.car.id} className="flex min-w-0 flex-col gap-3 rounded-card border border-grey-200 bg-white px-4 py-3.5">
                    <CarCard row={row} timeZone={timeZone} today={today} returnTo={returnTo} canManage={canManage} actions={actions} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-5">
          <Panel id="van-runs" title="Collections and deliveries">
            {legs.length === 0 ? (
              <p className="m-0 text-[14px] text-grey-600">
                No van runs booked. Switch on &ldquo;Collection and delivery&rdquo; for a service in{" "}
                <Link href="/app/settings/services" className={cn(textLinkClass, "text-[14px]")}>
                  Services &amp; prices
                </Link>
                , then add it from a booking or let customers choose it online.
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col p-0">
                {legs.map((leg) => (
                  <li key={leg.id} className="flex flex-col gap-0.5 border-t border-[#f1f5f9] py-2.5 first:border-t-0">
                    <span className="flex flex-wrap items-center gap-2">
                      <Truck size={16} strokeWidth={2} aria-hidden="true" className="text-grey-600" />
                      <span className="text-[14px] font-bold text-navy-950">
                        {LEG_LABELS[leg.leg]}, {formatShortDate(leg.startsAt, timeZone)} {formatTimeRange(leg.startsAt, leg.endsAt, timeZone)}
                      </span>
                      {leg.status === "unassigned" ? <Badge tone="warning">No van</Badge> : <Badge tone="info">{leg.resourceName ?? "Van"}</Badge>}
                    </span>
                    <span className="text-[13px] text-grey-600">
                      <Link href={`/app/bookings/${leg.bookingId}`} className={cn(textLinkClass, "text-[13px]")}>
                        {leg.reference ?? "Booking"}
                      </Link>
                      {leg.customerName ? ` · ${leg.customerName}` : null} · {leg.postcode}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {canManage ? (
            <Panel id="add-car" title="Add a courtesy car">
              <form action={addCarAction} className="flex flex-col gap-4">
                <input type="hidden" name="returnTo" value={returnTo} />
                <CarFields idPrefix="new-car" />
                <button type="submit" className={buttonClass("primary", "md", "w-full sm:w-fit")}>
                  Add car
                </button>
              </form>
            </Panel>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function CarCard({
  row,
  timeZone,
  today,
  returnTo,
  canManage,
  actions,
}: {
  row: CarWeek;
  timeZone: string;
  today: string;
  returnTo: string;
  canManage: boolean;
  actions: { release: typeof releaseLoanAction; checkOut: typeof checkOutAction; checkIn: typeof checkInAction };
}) {
  const { car } = row;
  const loans = [...new Map(row.days.flatMap((day) => day.loans).map((loan) => [loan.id, loan])).values()];
  const stateId = `car-${car.id}-state`;
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <h3 className="m-0 font-sans text-[16px] font-bold text-navy-950">{car.name}</h3>
        <PlateChip registration={car.registration} />
        <Badge tone={STATE_TONES[row.state]}>
          <span id={stateId}>{CAR_STATE_LABELS[row.state]}</span>
        </Badge>
      </div>
      <p className="m-0 text-[13px] text-grey-600">
        {formatMiles(car.mileage)} · fuel {fuelLabel(car.fuelEighths).toLowerCase()}
        {car.notes ? ` · ${car.notes}` : null}
      </p>

      <ol aria-label={`${car.name} this week`} className="m-0 grid list-none grid-cols-7 gap-1 p-0">
        {row.days.map((day) => {
          const busy = day.loans.some((loan) => loan.status !== "returned");
          const label = formatDateKey(day.dateKey);
          return (
            <li
              key={day.dateKey}
              className={cn(
                "flex min-h-11 flex-col items-center justify-center rounded-[8px] border text-[11.5px] leading-tight font-semibold",
                busy ? "border-[#1e40af] bg-[#1e40af] text-white" : "border-grey-200 bg-grey-50 text-grey-700",
                day.dateKey === today && "outline-2 outline-offset-1 outline-accent outline-solid",
              )}
            >
              <span aria-hidden="true">{label.split(" ")[0]}</span>
              <span aria-hidden="true">{label.split(" ")[1]}</span>
              <span className="sr-only">
                {label}: {busy ? `lent (${day.loans.length})` : "free"}
              </span>
            </li>
          );
        })}
      </ol>

      {loans.length > 0 ? (
        <div className="flex flex-col">
          {loans.map((loan) => (
            <LoanItem key={loan.id} loan={loan} carName={car.name} timeZone={timeZone} returnTo={returnTo} actions={actions} canAct currentMileage={car.mileage} />
          ))}
        </div>
      ) : (
        <p className="m-0 text-[14px] text-grey-600">Not lent this week. Lend it from a booking: open the booking and choose &ldquo;Add courtesy car&rdquo;.</p>
      )}

      {canManage ? (
        <details className="group">
          <summary className={courtesySummaryClass}>
            Edit <span className="sr-only">{car.name}</span>
          </summary>
          <div className="mt-2 flex flex-col gap-3 rounded-input bg-grey-50 p-3">
            <form action={updateCarAction} className="flex flex-col gap-3">
              <input type="hidden" name="carId" value={car.id} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <CarFields idPrefix={`car-${car.id}`} car={car} />
              <button type="submit" className={buttonClass("primary", "md", "w-full sm:w-fit")}>
                Save {car.name}
              </button>
            </form>
            <div className="flex flex-wrap items-center gap-3 border-t border-grey-200 pt-3">
              <form action={setCarActiveAction} className="flex items-center gap-2">
                <input type="hidden" name="carId" value={car.id} />
                <input type="hidden" name="returnTo" value={returnTo} />
                <input type="hidden" name="active" value={String(!car.active)} />
                <Switch type="submit" label={`${car.name} can be lent`} checked={car.active} describedBy={stateId} />
                <span className="text-[14px] text-grey-700">Can be lent</span>
              </form>
              <form action={deleteCarAction}>
                <input type="hidden" name="carId" value={car.id} />
                <input type="hidden" name="returnTo" value={returnTo} />
                <button type="submit" className={buttonClass("secondary", "md", "border-[#b91c1c] text-[#991b1b] hover:border-[#991b1b]")}>
                  Delete {car.name}
                </button>
              </form>
            </div>
          </div>
        </details>
      ) : null}
    </>
  );
}
