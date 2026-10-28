import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Warehouse } from "lucide-react";
import {
  buttonClass,
  DIARY_BLOCK_TONES,
  DiaryGrid,
  diaryTone,
  EmptyState,
  JobCard,
  PageHeader,
  statusLabel,
  textLinkClass,
} from "@/components/admin-ui";
import { formatTime } from "@/components/book/format";
import { formatRegistrationDisplay } from "@/components/book/plate-format";
import { bookingHref, type AdminBooking } from "@/lib/admin/bookings";
import { AdminDataError, loadBookingsStarting, loadOpeningHours, loadResources } from "@/lib/admin/data";
import { addDays, formatDayMonth, formatLongDate, formatShortDateKey, isoWeekday, localDateKey, localDayRange, startOfLocalDay, weekStart } from "@/lib/admin/dates";
import { diaryDayHref, diaryParams, diaryWeekHref, neighbourWeeks, shapeWeek, UNASSIGNED_ROW } from "@/lib/admin/diary";
import { diaryHours, toDiaryBooking } from "@/lib/admin/today";
import { courtesyBookingIds } from "@/lib/courtesy/server";
import { getAdminContext } from "@/lib/tenancy/admin";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Diary" };

const navButton = buttonClass("secondary", "md", "gap-1.5 px-3");

function Alert({ children }: { children: string }) {
  return (
    <div role="alert" className="rounded-card border border-[#f3c4c4] bg-[#fdecec] px-4 py-3.5 text-[14px] font-semibold text-[#991b1b]">
      {children}
    </div>
  );
}

function WeekBooking({ booking, timeZone }: { booking: AdminBooking; timeZone: string }) {
  const tone = DIARY_BLOCK_TONES[diaryTone(booking.status) ?? "booked"];
  const plate = booking.registration ? formatRegistrationDisplay(booking.registration) : "";
  return (
    <Link
      href={bookingHref(booking.id)}
      aria-label={[formatTime(booking.startsAt, timeZone), plate, booking.serviceName, booking.customerName, statusLabel(booking.status)].filter(Boolean).join(", ")}
      className={cn(
        "flex flex-col gap-0.5 rounded-[10px] px-2 py-1.5 no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        tone.block,
      )}
    >
      <span className={cn("truncate text-[12.5px] font-bold", tone.title)}>
        {formatTime(booking.startsAt, timeZone)} {booking.serviceName}
      </span>
      <span className={cn("truncate text-[11.5px]", tone.sub)}>{[plate, booking.model ?? booking.make].filter(Boolean).join(" · ")}</span>
    </Link>
  );
}

/**
 * Diary: the week by bay and van (`?week=` any date in the week), or one day on the diary grid
 * (`?day=`). Drag to move comes later: a booking moves from its own page.
 */
export default async function DiaryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  const timeZone = admin.garage.timezone || "Europe/London";
  const now = new Date();
  const today = localDateKey(now, timeZone);
  const { day, monday } = diaryParams(await searchParams, today);
  const weeks = neighbourWeeks(monday);
  const thisWeek = weekStart(today);

  const from = day ? localDayRange(day, timeZone).from : startOfLocalDay(monday, timeZone).toISOString();
  const to = day ? localDayRange(day, timeZone).to : startOfLocalDay(addDays(monday, 7), timeZone).toISOString();

  let loaded;
  try {
    loaded = await Promise.all([loadResources(admin.client), loadBookingsStarting(admin.client, from, to), loadOpeningHours(admin.client)]);
  } catch (error) {
    if (!(error instanceof AdminDataError)) throw error;
    loaded = null;
  }

  // P5.8: bookings with a courtesy car get a small car mark (never throws; no marks on failure).
  const courtesy = loaded ? await courtesyBookingIds(admin.client, admin.garage.id, loaded[1].map((booking) => booking.id)) : new Set<string>();

  const newBooking = (
    <Link href="/app/bookings/new" className={buttonClass("primary", "md", "px-[18px]")}>
      <Plus size={18} strokeWidth={2.4} aria-hidden="true" />
      New booking
    </Link>
  );

  if (day) {
    const hours = diaryHours(loaded?.[2].get(isoWeekday(day)) ?? [], loaded?.[1] ?? [], timeZone);
    return (
      <div className="flex flex-col gap-[18px]">
        <PageHeader eyebrow={day === today ? "Today" : "Diary"} title={formatLongDate(day)} actions={newBooking} />
        <nav aria-label="Days" className="flex flex-wrap gap-2.5">
          <Link href={diaryDayHref(addDays(day, -1))} className={navButton}>
            <ChevronLeft size={18} strokeWidth={2} aria-hidden="true" />
            {formatShortDateKey(addDays(day, -1))}
          </Link>
          <Link href={diaryDayHref(addDays(day, 1))} className={navButton}>
            {formatShortDateKey(addDays(day, 1))}
            <ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
          </Link>
          <Link href={diaryWeekHref(weekStart(day))} className={navButton}>
            <CalendarDays size={18} strokeWidth={2} aria-hidden="true" />
            Whole week
          </Link>
        </nav>
        {loaded ? (
          <DiaryGrid
            resources={loaded[0]}
            bookings={loaded[1].map((booking) => ({ ...toDiaryBooking(booking), courtesyCar: courtesy.has(booking.id) }))}
            date={day}
            timeZone={timeZone}
            now={now}
            startHour={hours.startHour}
            endHour={hours.endHour}
            title={day === today ? "Today's diary" : formatLongDate(day)}
          />
        ) : (
          <Alert>The diary could not be loaded. Refresh the page to try again.</Alert>
        )}
      </div>
    );
  }

  const header = (
    <PageHeader
      eyebrow={`Week of ${formatDayMonth(monday, Number(today.slice(0, 4)))}`}
      title="Diary"
      description="The week by bay and van. Open a booking to move it or change its status."
      actions={newBooking}
    />
  );
  const weekNav = (
    <nav aria-label="Weeks" className="flex flex-wrap gap-2.5">
      <Link href={diaryWeekHref(weeks.previous)} className={navButton}>
        <ChevronLeft size={18} strokeWidth={2} aria-hidden="true" />
        Previous week
      </Link>
      {monday !== thisWeek ? (
        <Link href={diaryWeekHref(thisWeek)} className={navButton}>
          This week
        </Link>
      ) : null}
      <Link href={diaryWeekHref(weeks.next)} className={navButton}>
        Next week
        <ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
      </Link>
    </nav>
  );

  if (!loaded) {
    return (
      <div className="flex flex-col gap-[18px]">
        {header}
        {weekNav}
        <Alert>The diary could not be loaded. Refresh the page to try again.</Alert>
      </div>
    );
  }

  const [resources, bookings, opening] = loaded;
  const week = shapeWeek({ bookings, resources, opening, monday, now, timeZone });
  const caption = `Bookings for the week of ${formatDayMonth(monday)}, by bay`;

  return (
    <div className="flex flex-col gap-[18px]">
      {header}
      {weekNav}

      {week.rows.length === 0 ? (
        <EmptyState
          tone="card"
          icon={Warehouse}
          title="No bays or vans set up yet"
          description="Add the bays and vans you book work into, and the week lines up here."
          action={
            <Link href="/app/settings/resources" className={buttonClass("secondary")}>
              Set up bays and vans
            </Link>
          }
        />
      ) : (
        <>
          {/* Phones: one list per day. */}
          <div className="flex flex-col gap-4 md:hidden">
            {week.days.map((weekDay) => {
              const items = week.byDay[weekDay.date] ?? [];
              const headingId = `diary-day-${weekDay.date}`;
              return (
                <section key={weekDay.date} aria-labelledby={headingId} className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <h2 id={headingId} className="m-0 font-sans text-[16px] font-bold tracking-normal text-navy-950">
                      {formatShortDateKey(weekDay.date)}
                      {weekDay.isToday ? <span className="ml-2 text-[12px] font-bold tracking-[0.08em] text-accent uppercase">Today</span> : null}
                    </h2>
                    <Link href={diaryDayHref(weekDay.date)} className={cn(textLinkClass, "ml-auto text-[14px]")}>
                      Day view<span className="sr-only">, {formatShortDateKey(weekDay.date)}</span>
                    </Link>
                  </div>
                  {items.length > 0 ? (
                    <ul className="m-0 flex list-none flex-col gap-2 p-0">
                      {items.map((booking) => (
                        <li key={booking.id}>
                          <JobCard
                            bookingId={booking.id}
                            startsAt={booking.startsAt}
                            timeZone={timeZone}
                            resourceName={booking.resourceName}
                            registration={booking.registration}
                            vehicle={booking.model ?? booking.make}
                            service={booking.serviceName}
                            status={booking.status}
                            href={bookingHref(booking.id)}
                            courtesyCar={courtesy.has(booking.id)}
                          />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="m-0 rounded-card border border-dashed border-grey-300 px-3.5 py-3 text-[14px] text-grey-600">
                      {weekDay.open ? "Nothing booked." : "Closed."}
                    </p>
                  )}
                </section>
              );
            })}
          </div>

          {/* Tablets and desktops: bays × days, scrolling inside its own box when narrow. */}
          <div className="hidden rounded-card border border-grey-200 bg-white p-[18px] md:block">
            <div role="region" aria-label={caption} tabIndex={0} className="relative overflow-x-auto rounded-[8px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
              <table className="w-full table-fixed border-collapse text-left" style={{ minWidth: 860 }}>
                <caption className="sr-only">{caption}</caption>
                <colgroup>
                  <col style={{ width: 104 }} />
                  {week.days.map((weekDay) => (
                    <col key={weekDay.date} />
                  ))}
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col" className="pb-2">
                      <span className="sr-only">Bay or van</span>
                    </th>
                    {week.days.map((weekDay) => (
                      <th key={weekDay.date} scope="col" className={cn("px-1 pb-2 align-bottom font-sans", !weekDay.open && "text-grey-600")}>
                        <Link
                          href={diaryDayHref(weekDay.date)}
                          className={cn(
                            "flex min-h-11 flex-col justify-center rounded-[10px] px-2 no-underline hover:bg-grey-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                            weekDay.isToday ? "text-accent" : "text-navy-950",
                          )}
                        >
                          <span className="text-[13px] font-bold">{formatShortDateKey(weekDay.date)}</span>
                          <span className="text-[12px] font-semibold text-grey-600">
                            {weekDay.isToday ? "Today · " : ""}
                            {weekDay.open ? `${weekDay.count} booked` : "Closed"}
                          </span>
                        </Link>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {week.rows.map((row) => (
                    <tr key={row.id} className="border-t border-[#eef2f6]">
                      <th scope="row" className="py-2 pr-2 align-top text-[13px] font-bold text-navy-950">
                        <span className="block truncate">{row.id === UNASSIGNED_ROW ? "Unassigned" : row.name}</span>
                      </th>
                      {week.days.map((weekDay) => {
                        const items = week.cells[row.id]?.[weekDay.date] ?? [];
                        return (
                          <td key={weekDay.date} className={cn("px-1 py-2 align-top", !weekDay.open && "bg-grey-50", weekDay.isToday && "bg-[#f3f7fd]")}>
                            {items.length > 0 ? (
                              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                                {items.map((booking) => (
                                  <li key={booking.id}>
                                    <WeekBooking booking={booking} timeZone={timeZone} />
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <span className="sr-only">Nothing booked</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {week.total === 0 ? <p className="m-0 pt-3 text-[14px] text-grey-600">Nothing booked this week.</p> : null}
          </div>
        </>
      )}
    </div>
  );
}
