import type { Metadata } from "next";
import { CalendarOff } from "lucide-react";
import { buttonClass, EmptyState, PageHeader, Panel } from "@/components/admin-ui";
import { dateKeyInZone } from "@/lib/booking-flow/dates";
import { canChangeGarage, canManageSetup, normaliseTime, WEEKDAYS } from "@/lib/settings/setup";
import { getAdminContext } from "@/lib/tenancy/admin";
import { FlashMessage, ReadOnlyNotice, SetupNav } from "../_components/setup-nav";
import { removeClosureAction } from "./actions";
import { BookingRulesForm } from "./booking-rules-form";
import { ClosureForm } from "./closure-form";
import { OpeningHoursForm, type WeekWindows } from "./opening-hours-form";

export const metadata: Metadata = { title: "Opening hours" };

const MESSAGES: Record<string, string> = {
  "done:closure_removed": "Closure removed. Customers can book those days again.",
  "error:not_allowed": "Only the garage's owners and managers can change closures.",
  "error:not_found": "That closure could not be found. It may have been removed already.",
  "error:save_failed": "That change could not be saved. Try again.",
};

type PageProps = { searchParams: Promise<{ done?: string | string[]; error?: string | string[] }> };
type Closure = { id: string; starts_on: string; ends_on: string; reason: string | null };

/** Setup · Opening hours: weekly windows, closures and the garage's booking rules. */
export default async function HoursSetupPage({ searchParams }: PageProps) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  const query = await searchParams;
  const timezone = admin?.garage.timezone ?? "Europe/London";
  const today = dateKeyInZone(new Date(), timezone);

  const [hours, closures, services, garageRules] = admin
    ? await Promise.all([
        admin.client.from("opening_hours").select("weekday,opens,closes").eq("garage_id", admin.garage.id).order("weekday").order("opens"),
        admin.client.from("closures").select("id,starts_on,ends_on,reason").eq("garage_id", admin.garage.id).gte("ends_on", today).order("starts_on"),
        admin.client.from("services").select("location_mode").eq("garage_id", admin.garage.id).is("deleted_at", null).eq("online_enabled", true),
        admin.client.from("garages").select("mobile_travel_min").eq("id", admin.garage.id).maybeSingle(),
      ])
    : [null, null, null, null];

  const week: WeekWindows = Object.fromEntries(WEEKDAYS.map(({ day }) => [day, [] as Array<{ opens: string; closes: string }>]));
  for (const row of (hours?.data ?? []) as Array<{ weekday: number; opens: string; closes: string }>) {
    week[row.weekday]?.push({ opens: normaliseTime(row.opens) ?? row.opens, closes: normaliseTime(row.closes) ?? row.closes });
  }
  const upcoming = (closures?.data ?? []) as Closure[];
  const offersMobile = ((services?.data ?? []) as Array<{ location_mode: string }>).some((service) => service.location_mode !== "workshop");
  const canEdit = canManageSetup(admin?.role);
  const mobileTravelMin = Number((garageRules?.data as { mobile_travel_min?: number } | null)?.mobile_travel_min ?? 30);

  return (
    <div className="flex flex-col gap-5 pb-10">
      <PageHeader
        eyebrow="Setup"
        title="Opening hours"
        description="When customers can book, the days you're closed, and the rules for online booking."
      />
      <SetupNav current="hours" />
      <FlashMessage messages={MESSAGES} done={query.done} error={query.error} />
      {!canEdit ? <ReadOnlyNotice level="manage" /> : null}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <OpeningHoursForm initial={week} canEdit={canEdit} />

        <Panel id="closures" title="Closures">
          <p className="m-0 text-[14px] text-grey-600">Bank holidays, training days, holidays. No times are offered on these days.</p>
          {upcoming.length ? (
            <ul aria-label="Upcoming closures" className="m-0 flex list-none flex-col p-0">
              {upcoming.map((closure) => (
                <li key={closure.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-[#f1f5f9] py-2.5 first:border-t-0">
                  <div className="flex min-w-0 flex-[1_1_180px] flex-col gap-0.5">
                    <span className="text-[15px] font-semibold text-navy-950">{closureDates(closure)}</span>
                    <span className="text-[13px] text-grey-600">{[closure.reason, closure.starts_on <= today ? "Closed now" : null].filter(Boolean).join(" · ") || "No reason given"}</span>
                  </div>
                  {canEdit ? (
                    <form action={removeClosureAction} className="ml-auto">
                      <input type="hidden" name="closureId" value={closure.id} />
                      <button type="submit" className={buttonClass("secondary", "sm")}>
                        Remove <span className="sr-only">closure {closureDates(closure)}</span>
                      </button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={CalendarOff} title="No closures coming up" description="Add bank holidays and days off so customers can't book them." className="py-5" />
          )}
          {canEdit ? <ClosureForm today={today} /> : null}
        </Panel>
      </div>

      <BookingRulesForm
        canEdit={canChangeGarage(admin?.role)}
        offersMobile={offersMobile}
        initial={{
          slotStepMin: admin?.garage.slotStepMin ?? 15,
          approveOnline: admin?.garage.approveOnline ?? false,
          cancellationCutoffH: admin?.garage.cancellationCutoffH ?? 24,
          mobileTravelMin,
          serviceArea: admin?.garage.serviceArea ?? [],
        }}
      />
    </div>
  );
}

const weekdayName = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" });
const monthName = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" });

/** `2026-12-25` → `Fri 25 Dec` (with ` 2026` when `withYear`). */
function calendarDay(dateKey: string, withYear: boolean) {
  const date = new Date(`${dateKey}T12:00:00Z`);
  const day = `${weekdayName.format(date)} ${date.getUTCDate()} ${monthName.format(date)}`;
  return withYear ? `${day} ${date.getUTCFullYear()}` : day;
}

/** `Fri 25 Dec to Mon 28 Dec 2026`, or one day. */
function closureDates(closure: Closure) {
  if (closure.starts_on === closure.ends_on) return calendarDay(closure.starts_on, true);
  const sameYear = closure.starts_on.slice(0, 4) === closure.ends_on.slice(0, 4);
  return `${calendarDay(closure.starts_on, !sameYear)} to ${calendarDay(closure.ends_on, true)}`;
}
