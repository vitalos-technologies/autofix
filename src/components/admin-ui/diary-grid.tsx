import Link from "next/link";
import { CarFront } from "lucide-react";
import type { ReactNode } from "react";
import { formatRegistrationDisplay } from "@/components/book/plate-format";
import { cn } from "@/lib/utils";
import { DEFAULT_GARAGE_TIME_ZONE, formatDateKey, formatTimeRange, minutesLabel, zonedMoment } from "./format";
import { statusLabel } from "./status-pill";
import { focusRing } from "./styles";
import type { BookingStatus } from "./types";

export type DiaryResource = { id: string; name: string };

export type DiaryBooking = {
  id: string;
  /** `bookings.resource_id`; `null` (or an id not in `resources`) goes in an "Unassigned" row. */
  resourceId: string | null;
  /** `timestamptz` ISO strings (or Dates). Positioned by wall-clock time in `timeZone`. */
  startsAt: string | Date;
  endsAt: string | Date;
  status: BookingStatus;
  registration: string;
  service: string;
  /** Model, e.g. "Focus" (second line, after the plate). */
  vehicle?: string;
  customerName?: string;
  /** Extra words after the service, e.g. "waiting on parts (ETA 12:00)". */
  detail?: string;
  /** Booking detail page. */
  href: string;
  /** P5.8: a courtesy car is reserved or out with this booking (small car icon on the block). */
  courtesyCar?: boolean;
};

export type DiaryGridProps = {
  resources: DiaryResource[];
  bookings: DiaryBooking[];
  /** The day shown, `YYYY-MM-DD` in the garage's time zone. */
  date: string;
  timeZone?: string;
  /** Current time. The red "now" line shows only when this falls on `date` inside the hours shown. */
  now?: string | Date;
  /** First hour shown (default 8 → 08:00). */
  startHour?: number;
  /** Hour the grid ends (default 17 → 17:00). */
  endHour?: number;
  /** Panel title; default "Today's diary" on today, otherwise the date ("Wed 28 Oct"). */
  title?: ReactNode;
  headingLevel?: 2 | 3;
  /** Shown when there are no resources. */
  emptyResources?: ReactNode;
  className?: string;
};

const SLOT_MINUTES = 30;
const LABEL_COLUMN = 92;
/** Under this width the grid scrolls sideways inside its own box. */
export const DIARY_MIN_WIDTH = 820;

export type DiaryTone = "booked" | "in_progress" | "waiting_parts" | "ready" | "requested" | "collected";

/** Block colours (design/screens/Admin-Dashboard.dc.html). Each text colour passes 4.5:1 on its fill. */
export const DIARY_BLOCK_TONES: Record<DiaryTone, { block: string; title: string; sub: string; legend: string; label: string }> = {
  booked: { block: "bg-[#dbe8fb]", title: "text-[#0d2a52]", sub: "text-[#2c4a73]", legend: "bg-[#dbe8fb]", label: "Booked" },
  in_progress: { block: "bg-[#2563eb]", title: "text-white", sub: "text-white", legend: "bg-[#2563eb]", label: "In progress" },
  waiting_parts: { block: "bg-[#fde7b0]", title: "text-[#5a3a00]", sub: "text-[#6e4a06]", legend: "bg-[#fde7b0]", label: "Waiting parts" },
  ready: { block: "bg-[#c9f0d6]", title: "text-[#0b3b1f]", sub: "text-[#1e5132]", legend: "bg-[#c9f0d6]", label: "Ready" },
  requested: {
    block: "border-[1.5px] border-dashed border-grey-600 bg-white",
    title: "text-navy-950",
    sub: "text-grey-700",
    legend: "border border-dashed border-grey-600 bg-white",
    label: "Needs OK",
  },
  collected: { block: "bg-grey-100", title: "text-grey-800", sub: "text-grey-700", legend: "bg-grey-100", label: "Collected" },
};

const LEGEND_ALWAYS: DiaryTone[] = ["booked", "in_progress", "waiting_parts", "ready"];

/** Diary colour of a booking status; `null` for cancelled and no-show (they no longer hold the bay). */
export function diaryTone(status: BookingStatus): DiaryTone | null {
  switch (status) {
    case "confirmed":
    case "arrived":
      return "booked";
    case "in_progress":
    case "waiting_parts":
    case "ready":
    case "requested":
    case "collected":
      return status;
    default:
      // Cancelled and no-show bookings no longer hold the bay, so the diary leaves them out.
      return null;
  }
}

export type DiaryPlacement = {
  /** Minutes from the start of the grid. */
  offset: number;
  /** Visible minutes. */
  length: number;
  /** Percentages of the timeline width, rounded to 4 decimals. */
  left: number;
  width: number;
  /** Cut at the start or end of the hours shown. */
  clippedStart: boolean;
  clippedEnd: boolean;
};

function round(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Where a booking sits on the day's timeline, by wall-clock time in `timeZone`, or `null` when it is
 * not on `date` inside the hours shown. On a clock-change day the wall clock is still right:
 * 09:15 GMT on Sun 25 Oct 2026 is drawn at 09:15, like 09:15 BST the day before.
 */
export function diaryPlacement(
  startsAt: string | Date,
  endsAt: string | Date,
  { date, timeZone = DEFAULT_GARAGE_TIME_ZONE, startHour = 8, endHour = 17 }: { date: string; timeZone?: string; startHour?: number; endHour?: number },
): DiaryPlacement | null {
  const start = zonedMoment(startsAt, timeZone);
  const end = zonedMoment(endsAt, timeZone);
  if (!start || !end) return null;
  if (start.dateKey > date || end.dateKey < date) return null;
  const startMinute = start.dateKey < date ? 0 : start.minutes;
  const endMinute = end.dateKey > date ? 24 * 60 : end.minutes;
  const windowStart = startHour * 60;
  const windowEnd = endHour * 60;
  const total = windowEnd - windowStart;
  if (total <= 0) return null;
  const from = Math.max(startMinute, windowStart);
  const to = Math.min(endMinute, windowEnd);
  if (to <= from) return null;
  return {
    offset: from - windowStart,
    length: to - from,
    left: round(((from - windowStart) / total) * 100),
    width: round(((to - from) / total) * 100),
    clippedStart: startMinute < windowStart,
    clippedEnd: endMinute > windowEnd,
  };
}

/** Accessible name of a block: "AB12 CDE, Diagnostics, 09:15 to 10:15, Bay 1, In bay". */
export function diaryBookingLabel(booking: DiaryBooking, resourceName: string, timeZone = DEFAULT_GARAGE_TIME_ZONE) {
  return [
    formatRegistrationDisplay(booking.registration),
    booking.detail ? `${booking.service}, ${booking.detail}` : booking.service,
    formatTimeRange(booking.startsAt, booking.endsAt, timeZone),
    resourceName,
    booking.customerName,
    booking.courtesyCar ? "courtesy car" : null,
    statusLabel(booking.status),
  ]
    .filter(Boolean)
    .join(", ");
}

const UNASSIGNED = "__unassigned__";

/**
 * Today's (or any day's) bookings by resource: rows are bays and vans, columns 30-minute slots
 * (hour labels and lines), blocks coloured by status. Under 820px it scrolls sideways inside its
 * own box with the resource names pinned. Server-compatible.
 */
export function DiaryGrid({
  resources,
  bookings,
  date,
  timeZone = DEFAULT_GARAGE_TIME_ZONE,
  now,
  startHour = 8,
  endHour = 17,
  title,
  headingLevel = 2,
  emptyResources,
  className,
}: DiaryGridProps) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const windowStart = startHour * 60;
  const windowEnd = endHour * 60;
  const total = Math.max(windowEnd - windowStart, SLOT_MINUTES);
  const nowMoment = now ? zonedMoment(now, timeZone) : null;
  const isToday = nowMoment?.dateKey === date;
  const nowLeft =
    isToday && nowMoment && nowMoment.minutes >= windowStart && nowMoment.minutes <= windowEnd
      ? round(((nowMoment.minutes - windowStart) / total) * 100)
      : null;
  const heading = title ?? (isToday ? "Today's diary" : `Diary, ${formatDateKey(date)}`);

  const known = new Set(resources.map((resource) => resource.id));
  const placed = bookings
    .map((booking) => {
      const tone = diaryTone(booking.status);
      const placement = tone ? diaryPlacement(booking.startsAt, booking.endsAt, { date, timeZone, startHour, endHour }) : null;
      return tone && placement ? { booking, tone, placement, row: booking.resourceId && known.has(booking.resourceId) ? booking.resourceId : UNASSIGNED } : null;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => a.placement.offset - b.placement.offset);

  const rows: DiaryResource[] = placed.some((item) => item.row === UNASSIGNED)
    ? [...resources, { id: UNASSIGNED, name: "Unassigned" }]
    : resources;

  const tonesUsed = new Set(placed.map((item) => item.tone));
  const legend = [...LEGEND_ALWAYS, ...(["requested", "collected"] as const).filter((tone) => tonesUsed.has(tone))];

  const hours: number[] = [];
  for (let hour = startHour; hour < endHour; hour += 1) hours.push(hour);
  const slotLines: { minute: number; hour: boolean }[] = [];
  for (let minute = SLOT_MINUTES; minute < total; minute += SLOT_MINUTES) {
    slotLines.push({ minute, hour: (windowStart + minute) % 60 === 0 });
  }

  return (
    <section
      aria-label={typeof heading === "string" ? heading : undefined}
      className={cn("flex min-w-0 flex-col gap-3.5 rounded-card border border-grey-200 bg-white px-[18px] pt-[18px] pb-5 font-sans leading-[normal]", className)}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Heading className="m-0 font-sans text-[17px] font-bold tracking-normal text-navy-950">{heading}</Heading>
        {rows.length > 0 ? (
          <ul aria-label="Colour key" className="m-0 ml-auto flex list-none flex-wrap gap-3.5 p-0 text-[12px] text-grey-700">
            {legend.map((tone) => (
              <li key={tone} className="flex items-center gap-1.5">
                <span aria-hidden="true" className={cn("size-2.5 rounded-[3px]", DIARY_BLOCK_TONES[tone].legend)} />
                {DIARY_BLOCK_TONES[tone].label}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {rows.length === 0 ? (
        (emptyResources ?? <p className="m-0 py-6 text-center text-[14px] text-grey-600">No bays or vans set up yet.</p>)
      ) : (
        <div
          role="region"
          aria-label={`${typeof heading === "string" ? heading : "Diary"}, by bay`}
          tabIndex={0}
          className={cn("relative overflow-x-auto rounded-[8px]", focusRing)}
        >
          <div className="relative" style={{ minWidth: DIARY_MIN_WIDTH }}>
            {/* Now line first, so the bookings paint over it (as drawn) and their text stays readable. */}
            {nowLeft !== null ? (
              <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0" style={{ left: LABEL_COLUMN }}>
                <span data-now-line="" className="absolute inset-y-0 -ml-[1.5px] w-[3px] rounded-[2px] bg-danger" style={{ left: `${nowLeft}%` }} />
              </div>
            ) : null}

            {/* Hour labels */}
            <div className="flex h-[26px]" aria-hidden="true">
              <div className="sticky left-0 z-[3] shrink-0 bg-white" style={{ width: LABEL_COLUMN }} />
              <div className="relative grow">
                {hours.map((hour) => (
                  <span
                    key={hour}
                    className="absolute top-0 text-[11.5px] text-grey-600"
                    style={{ left: `${round((((hour * 60) - windowStart) / total) * 100)}%` }}
                  >
                    {minutesLabel(hour * 60)}
                  </span>
                ))}
              </div>
            </div>

            <div className="relative flex flex-col gap-2">
              {/* Slot lines: hours darker than half hours. */}
              <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0" style={{ left: LABEL_COLUMN }}>
                <span className="absolute inset-y-0 left-0 w-px bg-[#f1f5f9]" />
                {slotLines.map((line) => (
                  <span
                    key={line.minute}
                    className={cn("absolute inset-y-0 w-px", line.hour ? "bg-[#f1f5f9]" : "bg-[#f5f7fa]")}
                    style={{ left: `${round((line.minute / total) * 100)}%` }}
                  />
                ))}
              </div>

              {rows.map((resource) => {
                const items = placed.filter((item) => item.row === resource.id);
                return (
                  <div key={resource.id} role="group" aria-label={resource.name} className="flex h-[58px]" data-resource-id={resource.id}>
                    <div
                      className="sticky left-0 z-[2] flex shrink-0 items-center bg-white pr-2 text-[13px] font-bold text-navy-950"
                      style={{ width: LABEL_COLUMN }}
                    >
                      <span className="truncate">{resource.name}</span>
                    </div>
                    <ul className="relative m-0 grow list-none p-0">
                      {items.map(({ booking, tone, placement }) => {
                        const colours = DIARY_BLOCK_TONES[tone];
                        const sub = [formatRegistrationDisplay(booking.registration), booking.vehicle ?? booking.customerName].filter(Boolean).join(" · ");
                        return (
                          <li
                            key={booking.id}
                            className="absolute inset-y-0 px-[3px]"
                            style={{ left: `${placement.left}%`, width: `${placement.width}%` }}
                            data-booking-id={booking.id}
                            data-start-minute={placement.offset}
                            data-length-minutes={placement.length}
                          >
                            <Link
                              href={booking.href}
                              aria-label={diaryBookingLabel(booking, resource.name, timeZone)}
                              className={cn(
                                "flex h-full flex-col gap-0.5 overflow-hidden rounded-[10px] px-2.5 py-2 no-underline hover:underline",
                                colours.block,
                                placement.clippedStart && "rounded-l-[3px]",
                                placement.clippedEnd && "rounded-r-[3px]",
                                focusRing,
                              )}
                            >
                              <span className={cn("truncate text-[12.5px] font-bold", colours.title)}>
                                {booking.courtesyCar ? <CarFront size={12} strokeWidth={2.4} aria-hidden="true" className="mr-1 inline-block align-[-1px]" /> : null}
                                {booking.detail ? `${booking.service} · ${booking.detail}` : booking.service}
                              </span>
                              <span className={cn("truncate text-[11.5px]", colours.sub)}>{sub}</span>
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {rows.length > 0 && placed.length === 0 ? <p className="m-0 text-[14px] text-grey-600">Nothing booked on this day.</p> : null}
    </section>
  );
}
