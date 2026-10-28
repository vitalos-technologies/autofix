import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { Download, Lock } from "lucide-react";
import { buttonClass, DataTable, KpiCard, KpiGrid, PageHeader, Panel, type DataTableColumn } from "@/components/admin-ui";
import { ProLockedPage } from "@/components/plans";
import { DEFAULT_TIME_ZONE, formatDayMonth, localDateKey } from "@/lib/admin/dates";
import { garageHasFeature } from "@/lib/plans/server";
import { smsSegmentCostPence } from "@/lib/reports/config";
import { PRESET_LABELS, RANGE_PROBLEMS, rangeQuery, REPORT_PRESETS, resolveReportRange, type ReportRange } from "@/lib/reports/range";
import { loadAllReports, type AllReports } from "@/lib/reports/server";
import {
  efficiency,
  formatMinutes,
  formatPounds,
  formatShare,
  hoursTotals,
  reminderKindName,
  revenueTotals,
  roiTotals,
  share,
  smsCost,
  utilisationByResource,
  utilisationByWeek,
  type HoursRow,
  type ReportKind,
  type RevenueRow,
  type UtilisationSummary,
  type UtilisationWeek,
} from "@/lib/reports/shape";
import { canManageSetup } from "@/lib/settings/setup";
import { getAdminContext } from "@/lib/tenancy/admin";
import { cn } from "@/lib/utils";
import { SetupNotice } from "../settings/_components/setup-nav";

export const metadata: Metadata = { title: "Reports" };

type PageProps = { searchParams: Promise<{ range?: string | string[]; from?: string | string[]; to?: string | string[] }> };

const fieldClass =
  "h-11 w-full min-w-0 rounded-input border border-grey-300 bg-white px-3 font-sans text-[15px] text-navy-950 focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent";
const noteClass = "m-0 text-[13.5px] leading-normal text-grey-700";
const subLine = "block text-[12.5px] font-normal text-grey-600";

function one(value: string | string[] | undefined) {
  return typeof value === "string" ? value : undefined;
}

function exportHref(kind: ReportKind, range: ReportRange) {
  return `/api/admin/reports/${kind}?${rangeQuery(range)}`;
}

function CsvLink({ kind, range, title }: { kind: ReportKind; range: ReportRange; title: string }) {
  return (
    <a href={exportHref(kind, range)} download className={buttonClass("secondary", "sm")} aria-label={`Download ${title.toLowerCase()} as CSV`}>
      <Download size={16} strokeWidth={2.2} aria-hidden="true" />
      CSV
    </a>
  );
}

/** A share as a plain bar with the figure next to it; the number is the accessible value. */
function ShareBar({ part, whole }: { part: number; whole: number }) {
  const value = share(part, whole);
  return (
    <span className="flex items-center justify-end gap-2">
      {value === null ? null : (
        <span aria-hidden="true" className="hidden h-2 w-16 overflow-hidden rounded-full bg-grey-100 sm:block">
          <span className="block h-full rounded-full bg-navy-950" style={{ width: `${Math.min(100, Math.round(value * 100))}%` }} />
        </span>
      )}
      <span className="font-semibold text-navy-950 tabular-nums">{formatShare(part, whole)}</span>
    </span>
  );
}

function revenueColumns(heading: string): DataTableColumn<RevenueRow>[] {
  return [
    { key: "name", header: heading, rowHeader: true, cell: (row) => row.name },
    { key: "jobs", header: "Jobs", align: "right", cell: (row) => <span className="tabular-nums">{row.bookings}</span> },
    {
      key: "total",
      header: "Revenue",
      align: "right",
      cell: (row) => (
        <span className="tabular-nums">
          <span className="font-semibold text-navy-950">{formatPounds(row.totalPence)}</span>
          {row.estimatedPence > 0 ? <span className={subLine}>{formatPounds(row.estimatedPence)} not invoiced yet</span> : null}
        </span>
      ),
    },
  ];
}

function withTotal(rows: RevenueRow[]): RevenueRow[] {
  if (rows.length < 2) return rows;
  return [...rows, { key: "total", name: "Total", ...revenueTotals(rows) }];
}

const utilisationColumns: DataTableColumn<UtilisationSummary>[] = [
  { key: "name", header: "Bay or van", rowHeader: true, cell: (row) => row.resourceName },
  {
    key: "booked",
    header: "Booked of open",
    align: "right",
    cell: (row) => <span className="tabular-nums">{`${formatMinutes(row.bookedMinutes)} of ${formatMinutes(row.openMinutes)}`}</span>,
  },
  { key: "use", header: "Use", align: "right", cell: (row) => <ShareBar part={row.bookedMinutes} whole={row.openMinutes} /> },
];

function weekColumns(currentYear: number): DataTableColumn<UtilisationWeek>[] {
  return [
    { key: "week", header: "Week of", rowHeader: true, cell: (row) => formatDayMonth(row.monday, currentYear) },
    {
      key: "booked",
      header: "Booked of open",
      align: "right",
      cell: (row) => <span className="tabular-nums">{`${formatMinutes(row.bookedMinutes)} of ${formatMinutes(row.openMinutes)}`}</span>,
    },
    { key: "use", header: "Use", align: "right", cell: (row) => <ShareBar part={row.bookedMinutes} whole={row.openMinutes} /> },
  ];
}

const hoursColumns: DataTableColumn<HoursRow>[] = [
  { key: "name", header: "Technician", rowHeader: true, cell: (row) => row.name },
  {
    key: "jobs",
    header: "Done",
    align: "right",
    cell: (row) => (
      <span className="tabular-nums">
        {row.measuredJobs}
        {row.jobs > row.measuredJobs ? <span className={subLine}>{row.jobs - row.measuredJobs} still open</span> : null}
      </span>
    ),
  },
  {
    key: "hours",
    header: "Sold / worked",
    align: "right",
    cell: (row) => <span className="tabular-nums">{`${formatMinutes(row.soldMinutes)} / ${formatMinutes(row.workedMinutes)}`}</span>,
  },
  { key: "ratio", header: "Ratio", align: "right", cell: (row) => <span className="font-semibold text-navy-950 tabular-nums">{efficiency(row)}</span> },
];

type RoiLine = { key: string; name: string; sent: number; booked: number; pence: number; segments: number | null; costPence: number | null };

function roiColumns(withCost: boolean): DataTableColumn<RoiLine>[] {
  return [
    { key: "name", header: "From", rowHeader: true, cell: (row) => row.name },
    { key: "sent", header: "Sent", align: "right", cell: (row) => <span className="tabular-nums">{row.sent}</span> },
    { key: "booked", header: "Booked", align: "right", cell: (row) => <span className="tabular-nums">{row.booked}</span> },
    {
      key: "won",
      header: "Won back",
      align: "right",
      cell: (row) => (
        <span className="tabular-nums">
          <span className="font-semibold text-navy-950">{formatPounds(row.pence)}</span>
          {row.segments !== null ? (
            <span className={subLine}>
              {row.segments} {row.segments === 1 ? "text" : "texts"}
              {withCost && row.costPence !== null ? `, ${formatPounds(row.costPence)}` : ""}
            </span>
          ) : null}
        </span>
      ),
    },
  ];
}

function ReportPanel({ id, title, kind, range, children }: { id: string; title: string; kind: ReportKind; range: ReportRange; children: ReactNode }) {
  return (
    <Panel id={id} title={title} actions={<CsvLink kind={kind} range={range} title={title} />}>
      {children}
    </Panel>
  );
}

function RangePicker({ range, problem }: { range: ReportRange; problem: string | null }) {
  return (
    <Panel title="Dates" className="gap-3">
      <nav aria-label="Report dates" className="-mx-[18px] overflow-x-auto px-[18px]">
        <ul className="m-0 flex w-max list-none gap-2 p-0 py-1">
          {REPORT_PRESETS.filter((preset) => preset !== "custom").map((preset) => {
            const active = range.preset === preset;
            return (
              <li key={preset}>
                <Link
                  href={`/app/reports?${rangeQuery({ preset, from: "", to: "" })}`}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex min-h-11 items-center rounded-full px-3.5 text-[13.5px] whitespace-nowrap no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                    active ? "bg-navy-950 font-bold text-white" : "border border-grey-300 bg-white font-semibold text-navy-950 hover:border-grey-600",
                  )}
                >
                  {PRESET_LABELS[preset]}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <form method="get" action="/app/reports" className="flex flex-wrap items-end gap-2.5">
        <input type="hidden" name="range" value="custom" />
        <div className="flex min-w-0 flex-[1_1_140px] flex-col gap-1.5">
          <label htmlFor="reports-from" className="text-[14px] font-semibold text-grey-800">
            From
          </label>
          <input id="reports-from" name="from" type="date" required defaultValue={range.from} className={fieldClass} />
        </div>
        <div className="flex min-w-0 flex-[1_1_140px] flex-col gap-1.5">
          <label htmlFor="reports-to" className="text-[14px] font-semibold text-grey-800">
            To
          </label>
          <input id="reports-to" name="to" type="date" required defaultValue={range.to} className={fieldClass} />
        </div>
        <button type="submit" className={buttonClass(range.preset === "custom" ? "primary" : "secondary")}>
          Show dates
        </button>
      </form>
      {problem ? <SetupNotice tone="danger">{problem} Showing this month instead.</SetupNotice> : null}
      <p className="m-0 text-[14px] text-grey-700" role="status">
        Showing <strong className="text-navy-950">{range.label}</strong> ({range.days} {range.days === 1 ? "day" : "days"}), in your garage&apos;s time.
      </p>
    </Panel>
  );
}

function Reports({ data, range, currentYear, costPerSegment }: { data: AllReports; range: ReportRange; currentYear: number; costPerSegment: number | null }) {
  const revenue = revenueTotals(data.revenueByService);
  const resources = utilisationByResource(data.utilisation);
  const weeks = utilisationByWeek(data.utilisation);
  const openAll = resources.reduce((sum, row) => sum + row.openMinutes, 0);
  const bookedAll = resources.reduce((sum, row) => sum + row.bookedMinutes, 0);
  const hoursTotal = hoursTotals(data.hours);
  const roi = roiTotals(data.reminderRoi, costPerSegment);
  const withCost = costPerSegment !== null;
  const roiLines: RoiLine[] = data.reminderRoi.map((row) => ({
    key: row.kind,
    name: reminderKindName(row.kind),
    sent: row.sent,
    booked: row.booked,
    pence: row.pence,
    segments: row.smsSegments,
    costPence: smsCost(row.smsSegments, costPerSegment),
  }));
  if (data.campaignRoi.available) {
    roiLines.push({ key: "campaigns", name: "Campaigns", sent: data.campaignRoi.sent, booked: data.campaignRoi.booked, pence: data.campaignRoi.pence, segments: null, costPence: null });
  }

  return (
    <>
      <KpiGrid label={`Summary, ${range.label}`}>
        <KpiCard size="sm" label="Revenue" value={formatPounds(revenue.totalPence)} context={`${revenue.bookings} ${revenue.bookings === 1 ? "job" : "jobs"}`} tone="navy" />
        <KpiCard size="sm" label="Bay use" value={formatShare(bookedAll, openAll)} context={`${formatMinutes(bookedAll)} booked`} />
        <KpiCard size="sm" label="Hours sold vs worked" value={efficiency(hoursTotal)} context={`${hoursTotal.measuredJobs} ${hoursTotal.measuredJobs === 1 ? "job" : "jobs"} done`} />
        <KpiCard size="sm" label="Won back by reminders" value={formatPounds(roi.pence)} context={`${roi.booked} booked from ${roi.sent} sent`} />
      </KpiGrid>

      <ReportPanel id="revenue-service" title="Revenue by service" kind="revenue-by-service" range={range}>
        <DataTable
          caption={`Revenue by service, ${range.label}`}
          columns={revenueColumns("Service")}
          rows={withTotal(data.revenueByService)}
          getRowKey={(row) => row.key}
          minWidth={300}
        />
        <p className={noteClass}>
          Jobs booked in these dates, except requests not yet accepted, cancellations, no-shows and the bin. A job counts at its issued or paid invoice;
          without one, at the price when it was booked.
        </p>
      </ReportPanel>

      <ReportPanel id="revenue-technician" title="Revenue by technician" kind="revenue-by-technician" range={range}>
        <DataTable
          caption={`Revenue by technician, ${range.label}`}
          columns={revenueColumns("Technician")}
          rows={withTotal(data.revenueByTechnician)}
          getRowKey={(row) => row.key}
          minWidth={300}
        />
        <p className={noteClass}>Choose who did each job on its booking page, under Technician. Jobs nobody is down for show as Unassigned.</p>
      </ReportPanel>

      <ReportPanel id="utilisation" title="Bay utilisation" kind="bay-utilisation" range={range}>
        <DataTable caption={`Bay utilisation by bay, ${range.label}`} columns={utilisationColumns} rows={resources} getRowKey={(row) => row.resourceId} minWidth={300} />
        {weeks.length > 1 ? (
          <>
            <h3 className="m-0 font-sans text-[12px] font-bold tracking-[0.06em] text-grey-600 uppercase">All bays, week by week</h3>
            <DataTable caption={`Bay utilisation by week, ${range.label}`} columns={weekColumns(currentYear)} rows={weeks} getRowKey={(row) => row.monday} minWidth={300} />
          </>
        ) : null}
        <p className={noteClass}>
          Booked time (including buffers and van travel) inside your opening hours, against those hours less closures. The CSV has every day for every bay.
        </p>
      </ReportPanel>

      <ReportPanel id="hours" title="Hours sold vs worked" kind="hours" range={range}>
        <DataTable caption={`Hours sold vs worked, ${range.label}`} columns={hoursColumns} rows={data.hours} getRowKey={(row) => row.key} minWidth={300} />
        <p className={noteClass}>
          Sold is the booked length of each job. Worked is the time it was In the bay (Waiting parts is left out), or from Arrived to the next step when it never
          went In the bay. Only jobs marked Ready or Collected count. Ratio is sold divided by worked: over 100% means jobs took less time than was sold.
        </p>
      </ReportPanel>

      <ReportPanel id="reminders" title="Reminder return" kind="reminder-roi" range={range}>
        <DataTable caption={`Reminder return, ${range.label}`} columns={roiColumns(withCost)} rows={roiLines} getRowKey={(row) => row.key} minWidth={300} />
        <p className={noteClass}>
          Sent in these dates; bookings made from a reminder link in these dates, at their invoice or booked price.{" "}
          {withCost && roi.smsCostPence !== null
            ? `Texts cost ${formatPounds(roi.smsCostPence)} in all (${roi.smsSegments} texts).`
            : `${roi.smsSegments} ${roi.smsSegments === 1 ? "text" : "texts"} sent; the cost shows here once Vitalos sets the price per text.`}
        </p>
      </ReportPanel>
    </>
  );
}

/** Reports (P5.6, Pro): revenue, bay use, hours and reminder return for a date range, each with a CSV. */
export default async function ReportsPage({ searchParams }: PageProps) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");

  if (!garageHasFeature(admin.garage, "advanced_reports")) {
    return <ProLockedPage feature="advanced_reports" title="Reports" canUpgrade={admin.role === "owner"} />;
  }

  if (!canManageSetup(admin.role)) {
    return (
      <div className="flex flex-col gap-5 pb-10">
        <PageHeader title="Reports" description="Revenue, bay use, hours and reminder return." />
        <Panel
          title={
            <span className="inline-flex items-center gap-2">
              <Lock size={16} strokeWidth={2.2} aria-hidden="true" />
              Reports are for owners and managers
            </span>
          }
        >
          <p className="m-0 text-[15px] leading-normal text-grey-700">Ask the garage owner if you need to see these figures. Today and the Diary are unchanged.</p>
          <Link href="/app" className={buttonClass("secondary", "md", "self-start")}>
            Back to Today
          </Link>
        </Panel>
      </div>
    );
  }

  const query = await searchParams;
  const timeZone = admin.garage.timezone || DEFAULT_TIME_ZONE;
  const today = localDateKey(new Date(), timeZone);
  const { range, problem } = resolveReportRange({ range: one(query.range), from: one(query.from), to: one(query.to) }, today);
  const costPerSegment = smsSegmentCostPence(process.env);

  let data: AllReports | null = null;
  try {
    data = await loadAllReports(admin.client, range);
  } catch (error) {
    console.error("[reports] load failed", error instanceof Error ? error.message : "unknown");
  }

  return (
    <div className="flex flex-col gap-[18px] pb-10">
      <PageHeader
        eyebrow="Pro"
        title="Reports"
        description="Where the money comes from, how busy the bays are, hours sold against hours worked and what reminders win back. Download any of them as CSV."
      />
      <RangePicker range={range} problem={problem ? RANGE_PROBLEMS[problem] : null} />
      {data ? (
        <Reports data={data} range={range} currentYear={Number(today.slice(0, 4))} costPerSegment={costPerSegment} />
      ) : (
        <SetupNotice tone="danger">These reports could not be loaded. Refresh the page to try again.</SetupNotice>
      )}
    </div>
  );
}
