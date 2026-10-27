import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { BellRing, CalendarPlus, Plus, Warehouse } from "lucide-react";
import {
  ApprovalCard,
  buttonClass,
  CopyButton,
  DiaryGrid,
  EmptyState,
  JobCard,
  KpiCard,
  KpiGrid,
  MissedCallCard,
  PageHeader,
  Panel,
  SummaryChips,
  textLinkClass,
  type ApprovalSecondary,
  type JobCardAction,
} from "@/components/admin-ui";
import { IN_WORKSHOP, quickActionLabel, quickStatusActions } from "@/lib/admin/booking-status";
import { auditActionLabel, auditEntityLabel, formatRelativeTime } from "@/lib/admin/dashboard";
import { bookingDetail, bookingHref, telLink, vehicleName, type AdminBooking } from "@/lib/admin/bookings";
import {
  AdminDataError,
  loadBookingsStarting,
  loadRecentActivity,
  loadOpeningHours,
  loadOpenRequests,
  loadReminderWeek,
  loadResources,
  type ActivityEntry,
} from "@/lib/admin/data";
import { loadReminderMonth } from "@/lib/admin/reminders";
import { formatLongDate, formatShortDateKey, isoWeekday, localDateKey, localDayRange, localWeekRange, monthStart } from "@/lib/admin/dates";
import { formatWholePounds, shapeToday, todayChips, type ReminderWeek } from "@/lib/admin/today";
import { markMissedCallHandledAction } from "@/lib/calls/actions";
import { countMissedCallsNeedingOk, listMissedCallsNeedingOk } from "@/lib/calls/missed-calls";
import { getAdminContext } from "@/lib/tenancy/admin";
import { garageBaseUrl } from "@/lib/tenancy/urls";
import { cn } from "@/lib/utils";
import { acceptBookingAction, quickStatusAction } from "./bookings/status-actions";

export const metadata: Metadata = { title: "Today" };

const twoColumns = "flex flex-wrap items-start gap-[18px]";
const sideColumn = "flex min-w-0 flex-[1_1_300px] flex-col gap-[18px]";

function firstName(name: string) {
  const first = name.trim().split(/\s+/)[0] ?? "";
  return first.includes("@") ? "" : first;
}

function secondaryFor(booking: AdminBooking, tone: "light" | "navy"): ApprovalSecondary {
  const tel = telLink(booking.customerPhone);
  if (booking.source === "missed_call" && tel) return { href: tel, label: "Call back" };
  return { href: `${bookingHref(booking.id)}#move`, label: tone === "navy" ? "Other time" : "Offer another time" };
}

function jobActions(booking: AdminBooking): JobCardAction[] {
  return quickStatusActions(booking.status).map((to) => ({
    label: quickActionLabel(to, booking.status),
    action: quickStatusAction,
    fields: { status: to },
    variant: to === "ready" ? "success" : "secondary",
  }));
}

/**
 * Today (design/screens/Admin-Dashboard.dc.html from 1024px, Admin-Today-Phone.dc.html below):
 * the day's diary by bay, what needs the garage's OK and the reminders week. Every read goes
 * through the selected garage's RLS client.
 */
export default async function TodayPage() {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  const timeZone = admin.garage.timezone || "Europe/London";
  const now = new Date();
  const dateKey = localDateKey(now, timeZone);
  const day = localDayRange(dateKey, timeZone);
  const week = localWeekRange(dateKey, timeZone);
  const bookingLink = garageBaseUrl(admin.garage);

  let loaded;
  try {
    loaded = await Promise.all([
      loadResources(admin.client),
      loadBookingsStarting(admin.client, day.from, day.to),
      loadOpenRequests(admin.client, now),
      loadOpeningHours(admin.client),
      loadReminderMonth(admin.client, admin.garage.id, monthStart(dateKey), timeZone),
      loadReminderWeek(admin.client, week.from, week.to),
      listMissedCallsNeedingOk(admin.client, admin.garage.id, { limit: 10 }),
      countMissedCallsNeedingOk(admin.client, admin.garage.id),
      loadRecentActivity(admin.client),
    ]);
  } catch (error) {
    if (!(error instanceof AdminDataError)) throw error;
    loaded = null;
  }

  const header = (title: string, phoneChips?: ReactNode) => (
    <PageHeader
      eyebrow={formatLongDate(dateKey)}
      phoneEyebrow={formatShortDateKey(dateKey)}
      title={title}
      phoneTitle="Today"
      actions={
        <div className="hidden gap-2.5 lg:flex">
          <CopyButton value={bookingLink} label="Copy booking link" />
          <Link href="/app/bookings/new" className={buttonClass("primary", "md", "px-[18px]")}>
            <Plus size={18} strokeWidth={2.4} aria-hidden="true" />
            New booking
          </Link>
        </div>
      }
    >
      {phoneChips}
    </PageHeader>
  );

  if (!loaded) {
    return (
      <div className="flex flex-col gap-[22px]">
        {header("Today")}
        <div role="alert" className="rounded-card border border-[#f3c4c4] bg-[#fdecec] px-4 py-3.5 text-[14px] font-semibold text-[#991b1b]">
          Today&apos;s bookings could not be loaded. Refresh the page to try again.
        </div>
      </div>
    );
  }

  const [resources, today, requests, opening, reminderMonth, reminders, calls, missedCount, activity] = loaded;
  const view = shapeToday({
    today,
    requests: requests.rows,
    requestCount: requests.count,
    opening: opening.get(isoWeekday(dateKey)) ?? [],
    now,
    timeZone,
    firstName: firstName(admin.profile.display_name),
  });
  const { figures } = view;
  const missed = Math.max(missedCount, calls.length);
  const chips = todayChips(figures, undefined, missed);
  const waiting = view.approvals.length + calls.length;
  const wonBack = { pence: reminderMonth?.pence ?? 0, bookings: reminderMonth?.booked ?? 0 };

  return (
    <div className="flex flex-col gap-3.5 lg:gap-[22px]">
      {header(
        view.headline,
        <div className="lg:hidden">
          <SummaryChips label="Today at a glance" chips={chips} />
        </div>,
      )}

      {/* Phone (Admin-Today-Phone) */}
      <div className="flex flex-col gap-2.5 lg:hidden">
        {waiting > 0 ? (
          <section id="needs-ok-phone" aria-labelledby="needs-ok-phone-title" className="flex scroll-mt-4 flex-col gap-2.5">
            <h2 id="needs-ok-phone-title" className="sr-only">
              Needs your OK
            </h2>
            {view.approvals.map((booking) => (
              <ApprovalCard
                key={booking.id}
                tone="navy"
                bookingId={booking.id}
                registration={booking.registration}
                source={booking.source}
                receivedAt={booking.createdAt}
                now={now}
                customerName={booking.customerName}
                vehicle={vehicleName(booking) ?? undefined}
                service={booking.serviceName}
                detail={bookingDetail(booking)}
                startsAt={booking.startsAt}
                timeZone={timeZone}
                acceptAction={acceptBookingAction}
                secondary={secondaryFor(booking, "navy")}
              />
            ))}
            {calls.map((call) => (
              <MissedCallCard key={call.id} call={call} timeZone={timeZone} tone="navy" markHandledAction={markMissedCallHandledAction} />
            ))}
            {requests.count > view.approvals.length ? (
              <Link href="/app/bookings?status=requested" className={cn(textLinkClass, "self-start text-[14px]")}>
                See all {requests.count} waiting for your OK
              </Link>
            ) : null}
          </section>
        ) : null}

        <h2 className="sr-only">Cars today</h2>
        {view.jobs.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
            {view.jobs.map((booking) => (
              <li key={booking.id}>
                <JobCard
                  bookingId={booking.id}
                  startsAt={booking.startsAt}
                  timeZone={timeZone}
                  resourceName={booking.resourceName ?? (booking.locationMode === "mobile" ? "Mobile" : null)}
                  registration={booking.registration}
                  vehicle={booking.model ?? booking.make}
                  service={booking.serviceName}
                  detail={booking.status === "waiting_parts" ? "waiting on parts" : bookingDetail(booking)}
                  status={booking.status}
                  href={bookingHref(booking.id)}
                  active={IN_WORKSHOP.includes(booking.status)}
                  actions={jobActions(booking)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            tone="card"
            icon={CalendarPlus}
            title="No cars booked in today"
            description="Online, phone and walk-in bookings for today show up here."
            action={
              <Link href="/app/bookings/new" className={buttonClass("primary")}>
                New booking
              </Link>
            }
          />
        )}
        <RecentActivityPanel id="activity-phone" entries={activity} userId={admin.user.id} now={now} className="mt-1.5" />
      </div>

      {/* Desktop (Admin-Dashboard) */}
      <div className="hidden flex-col gap-[22px] lg:flex">
        <KpiGrid label="Today at a glance">
          <KpiCard label="Booked in today" value={String(figures.carsToday)} context={`${figures.stillToArrive} still to arrive`} />
          <KpiCard
            label="In the workshop"
            value={String(figures.inWorkshop)}
            context={figures.waitingParts > 0 ? `${figures.waitingParts} waiting for parts` : "None waiting for parts"}
          />
          <KpiCard
            label="Won back by reminders"
            value={formatWholePounds(wonBack.pence)}
            tone="navy"
            trend={
              wonBack.bookings > 0
                ? { label: `${wonBack.bookings} ${wonBack.bookings === 1 ? "booking" : "bookings"} this month` }
                : { label: "No reminder bookings this month yet", tone: "neutral" }
            }
          />
          <KpiCard label="Ready to collect" value={String(figures.ready)} context={`${figures.collected} collected today`} />
        </KpiGrid>

        <div className={twoColumns}>
          <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-[18px]">
            <DiaryGrid
              className="min-w-0"
              resources={resources}
              bookings={view.diary}
              date={dateKey}
              timeZone={timeZone}
              now={now}
              startHour={view.hours.startHour}
              endHour={view.hours.endHour}
              emptyResources={
                <EmptyState
                  icon={Warehouse}
                  title="No bays or vans set up yet"
                  description="Add the bays and vans you book work into, and today's bookings line up here."
                  action={
                    <Link href="/app/settings/resources" className={buttonClass("secondary")}>
                      Set up bays and vans
                    </Link>
                  }
                />
              }
            />
            <RecentActivityPanel id="activity" entries={activity} userId={admin.user.id} now={now} />
          </div>
          <div className={sideColumn}>
            <Panel id="needs-ok" title="Needs your OK" count={requests.count + missed} countLabel={`${requests.count + missed} waiting`}>
              {waiting > 0 ? (
                <ul className="m-0 flex list-none flex-col p-0">
                  {view.approvals.map((booking) => (
                    <li key={booking.id} className="border-b border-[#eef2f6] py-3.5 first:pt-0 last:border-b-0 last:pb-0">
                      <ApprovalCard
                        bookingId={booking.id}
                        registration={booking.registration}
                        source={booking.source}
                        receivedAt={booking.createdAt}
                        now={now}
                        customerName={booking.customerName}
                        service={booking.serviceName}
                        detail={bookingDetail(booking)}
                        startsAt={booking.startsAt}
                        timeZone={timeZone}
                        acceptAction={acceptBookingAction}
                        secondary={secondaryFor(booking, "light")}
                      />
                    </li>
                  ))}
                  {calls.map((call) => (
                    <li key={call.id} className="border-b border-[#eef2f6] py-3.5 first:pt-0 last:border-b-0 last:pb-0">
                      <MissedCallCard call={call} timeZone={timeZone} tone="light" markHandledAction={markMissedCallHandledAction} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-0 text-[14px] text-grey-600">Nothing waiting for your OK.</p>
              )}
              {requests.count > view.approvals.length ? (
                <Link href="/app/bookings?status=requested" className={cn(textLinkClass, "self-start text-[14px]")}>
                  See all {requests.count}
                </Link>
              ) : null}
            </Panel>
            <RemindersPanel reminders={reminders} />
          </div>
        </div>
      </div>
    </div>
  );
}

function RemindersPanel({ reminders }: { reminders: ReminderWeek | null }) {
  return (
    <Panel id="reminders-week" title="Reminders this week" className="gap-3">
      {reminders ? (
        <dl className="m-0 grid grid-cols-3 gap-2 text-center">
          {[
            { label: "Due", value: reminders.due, success: false },
            { label: "Sent", value: reminders.sent, success: false },
            { label: "Booked", value: reminders.booked, success: true },
          ].map((item) => (
            <div key={item.label} className={cn("flex flex-col-reverse gap-0.5 rounded-input px-1 py-2.5", item.success ? "bg-success-bg" : "bg-grey-50")}>
              <dt className={cn("text-[12px]", item.success ? "text-success-ink" : "text-grey-600")}>{item.label}</dt>
              <dd className={cn("m-0 font-display text-[26px] font-bold", item.success ? "text-success-ink" : "text-navy-950")}>{item.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <EmptyState
          className="py-4"
          icon={BellRing}
          title="Reminders are on their way"
          description="MOT and service reminders that bring customers back will show here: how many are due, sent and booked this week."
        />
      )}
      <Link href="/app/reminders" className={cn(textLinkClass, "self-start text-[14px]")}>
        Open reminders →
      </Link>
    </Panel>
  );
}

/** SOB's Recent activity (the garage's audit log), kept for P4.9's opt-out and agreement records. */
function RecentActivityPanel({ id, entries, userId, now, className }: { id: string; entries: ActivityEntry[] | null; userId: string; now: Date; className?: string }) {
  return (
    <Panel id={id} title="Recent activity" className={className}>
      {entries === null ? (
        <p className="m-0 text-[14px] text-grey-600">Recent activity could not be loaded.</p>
      ) : entries.length === 0 ? (
        <p className="m-0 text-[14px] text-grey-600">Changes to bookings, invoices, settings and customers&apos; reminder choices show up here.</p>
      ) : (
        <ol className="m-0 flex list-none flex-col p-0">
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-col gap-0.5 border-t border-[#eef2f6] py-2.5 first:border-t-0 first:pt-0 last:pb-0">
              <p className="m-0 text-[14px] text-grey-800">
                <strong className="font-semibold text-navy-950">{auditActionLabel(entry.action, entry.entityType)}</strong> {auditEntityLabel(entry.entityType, entry.detail)}
              </p>
              <p className="m-0 text-[12.5px] text-grey-600">
                {entry.actorId ? (entry.actorId === userId ? "You" : "Staff") : "System"} · <time dateTime={entry.at}>{formatRelativeTime(entry.at, now)}</time>
              </p>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
