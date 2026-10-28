import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Building2, Download, Plus } from "lucide-react";
import { Badge, buttonClass, DataTable, formatDateKey, KpiCard, KpiGrid, PageHeader, Panel, SubmitButton, type DataTableColumn } from "@/components/admin-ui";
import { inputClass } from "@/components/onboarding/field";
import { AddSiteForm } from "@/components/group/add-site-form";
import { ProLockedPage } from "@/components/plans";
import { localDateKey } from "@/lib/admin/dates";
import { formatWholePounds } from "@/lib/admin/today";
import { removeSiteAction } from "@/lib/group/actions";
import {
  extraSitePriceLine,
  extraSites,
  extraSitesLabel,
  overviewTotals,
  parseReportRange,
  reportTotals,
  type GroupOverviewSite,
  type GroupReportSite,
} from "@/lib/group/report";
import { GroupDataError, loadGroupOverview, loadGroupReport, loadGroupSummary } from "@/lib/group/server";
import { getPlansConfig } from "@/lib/plans/config";
import { garageHasFeature } from "@/lib/plans/server";
import { getAdminContext } from "@/lib/tenancy/admin";
import { switchGarage } from "@/lib/tenancy/switch-garage";
import { garageBaseUrl } from "@/lib/tenancy/urls";
import { FlashMessage, SetupNotice } from "../settings/_components/setup-nav";

export const metadata: Metadata = { title: "Group overview" };

const PATH = "/app/group";

const MESSAGES: Record<string, string> = {
  "done:site_removed": "The site is out of the group. It keeps its customers and bookings, and moves to Essentials.",
  "done:site_removed_billing": "The site is out of the group. The extra-site charge could not be updated just now; it is logged for Vitalos to check.",
  "error:owner_only": "Only the owner of every site involved can do that, with their sign-in verified.",
  "error:home_site": "The home garage holds the group's plan, so it can't leave the group.",
  "error:remove_failed": "The site could not be removed. Try again.",
};

type SearchParams = { from?: string; to?: string; done?: string; error?: string; confirm?: string };

function siteLabel(site: Pick<GroupOverviewSite, "name" | "isHome" | "isSelected">) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="font-semibold break-words text-navy-950">{site.name}</span>
      {site.isHome ? <Badge tone="info" size="xs">Home</Badge> : null}
      {site.isSelected ? <Badge tone="neutral" size="xs">You&apos;re here</Badge> : null}
    </span>
  );
}

function OpenSiteButton({ site }: { site: GroupOverviewSite }) {
  if (site.isSelected) return null;
  return (
    <form action={switchGarage}>
      <SubmitButton name="garageId" value={site.garageId} className={buttonClass("secondary", "sm")}>
        Open<span className="sr-only"> {site.name}</span>
      </SubmitButton>
    </form>
  );
}

function RemoveSiteLink({ site }: { site: GroupOverviewSite }) {
  if (site.isHome) return null;
  return (
    <Link href={`${PATH}?confirm=${site.garageId}#sites`} className={buttonClass("ghost", "sm")}>
      Remove<span className="sr-only"> {site.name} from the group</span>
    </Link>
  );
}

const reportColumns: DataTableColumn<GroupReportSite & { total?: boolean }>[] = [
  { key: "site", header: "Site", rowHeader: true, cell: (row) => (row.total ? <strong>All sites</strong> : row.name) },
  { key: "bookings", header: "Bookings", align: "right", cell: (row) => (row.total ? <strong>{row.bookings}</strong> : row.bookings) },
  { key: "revenue", header: "Revenue", align: "right", cell: (row) => (row.total ? <strong>{formatWholePounds(row.revenuePence)}</strong> : formatWholePounds(row.revenuePence)) },
];

/**
 * Group overview (P5.9, Pro `multi_site`): every site of the selected garage's group the member is owner
 * or manager of, with today's bookings, open requests, revenue and reminder work won back this month;
 * group reports by date range with a CSV export; owners add or remove sites. All figures come from
 * group_overview()/group_report() through the member's RLS client (x-garage-id = the selected garage).
 */
export default async function GroupPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  const query = await searchParams;
  const isOwner = admin.role === "owner";

  if (admin.role !== "owner" && admin.role !== "manager") {
    return (
      <div className="flex flex-col gap-5 pb-10">
        <PageHeader eyebrow="Grow" title="Group overview" />
        <SetupNotice>Only owners and managers see the group overview. Ask the garage owner if you need it.</SetupNotice>
      </div>
    );
  }

  const summary = await loadGroupSummary(admin.client, admin.garage.id);
  if (!garageHasFeature(admin.garage, "multi_site") || (summary && !summary.multiSite)) {
    return <ProLockedPage feature="multi_site" title="Group overview" canUpgrade={isOwner} hasExistingData={Boolean(summary?.groupId)} />;
  }

  const timeZone = admin.garage.timezone || "Europe/London";
  const now = new Date();
  const todayKey = localDateKey(now, timeZone);
  const range = parseReportRange({ from: query.from, to: query.to }, todayKey);

  let sites: GroupOverviewSite[] | null = null;
  let report: GroupReportSite[] | null = null;
  try {
    [sites, report] = await Promise.all([loadGroupOverview(admin.client, now), loadGroupReport(admin.client, range)]);
  } catch (error) {
    if (!(error instanceof GroupDataError)) throw error;
    if (error.code === "PLAN_REQUIRED") {
      return <ProLockedPage feature="multi_site" title="Group overview" canUpgrade={isOwner} hasExistingData={Boolean(summary?.groupId)} />;
    }
  }

  const siteCount = summary?.siteCount ?? sites?.length ?? 1;
  const hidden = Math.max(0, siteCount - (sites?.length ?? siteCount));
  const totals = sites ? overviewTotals(sites) : null;
  const reportTotal = report ? reportTotals(report) : null;
  const confirmSite = isOwner && query.confirm ? sites?.find((site) => site.garageId === query.confirm && !site.isHome) : undefined;
  const canAdd = Boolean(summary?.canAddSites) && isOwner;
  const extra = extraSites(siteCount);
  const priceLine = extraSitePriceLine(getPlansConfig(process.env).extraSitePricePence);
  const linkExample = new URL(garageBaseUrl({ slug: "your-link" })).host;
  const csvHref = `/api/admin/group/report?from=${range.from}&to=${range.to}`;

  return (
    <div className="flex flex-col gap-[22px] pb-10">
      <PageHeader
        eyebrow="Grow"
        title="Group overview"
        description={siteCount > 1 ? `${siteCount} sites under one login. Figures are for each site's own day and month.` : "Run several sites under one login. Add your next site below."}
        actions={canAdd ? (
          <Link href="#add-site" className={buttonClass("primary", "md")}>
            <Plus size={18} strokeWidth={2.4} aria-hidden="true" />
            Add a site
          </Link>
        ) : undefined}
      />
      <FlashMessage messages={MESSAGES} done={query.done} error={query.error} />

      {confirmSite ? (
        <Panel id="confirm-remove" title={`Take ${confirmSite.name} out of the group?`} highlight className="scroll-mt-4">
          <p className="m-0 text-[14px] leading-normal text-grey-800">
            Nothing is deleted: the garage keeps its customers, bookings and booking page, and you stay its owner. It leaves the group&apos;s figures, moves
            to Essentials, and the group pays for one site fewer.
          </p>
          <div className="flex flex-wrap gap-2.5">
            <form action={removeSiteAction} className="flex flex-1 sm:flex-none">
              <input type="hidden" name="siteId" value={confirmSite.garageId} />
              <input type="hidden" name="confirm" value="yes" />
              <SubmitButton className={buttonClass("primary", "md", "w-full")}>Take it out of the group</SubmitButton>
            </form>
            <Link href={PATH} className={buttonClass("secondary", "md", "flex-1 sm:flex-none")}>Keep it</Link>
          </div>
        </Panel>
      ) : null}

      {sites && totals ? (
        <KpiGrid label="All sites">
          <KpiCard size="sm" label="Cars in today" value={String(totals.todayBookings)} />
          <KpiCard size="sm" label="Waiting for your OK" value={String(totals.openRequests)} />
          <KpiCard size="sm" label="Revenue this month" value={formatWholePounds(totals.revenueMonthPence)} />
          <KpiCard size="sm" label="Won back by reminders" value={formatWholePounds(totals.wonBackPence)} context={`${totals.wonBackBookings} bookings this month`} tone="navy" />
        </KpiGrid>
      ) : (
        <SetupNotice tone="danger">The group&apos;s figures could not be loaded. Refresh the page to try again.</SetupNotice>
      )}

      <Panel id="sites" title="Sites" count={sites?.length ?? 0} countLabel="sites" className="scroll-mt-4">
        {sites ? (
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0" aria-label="Sites in your group">
            {sites.map((site) => (
              <li key={site.garageId} className="flex flex-col gap-3 rounded-input border border-grey-200 p-3.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h3 className="m-0 min-w-0 text-[15px]">{siteLabel(site)}</h3>
                  <div className="flex flex-wrap gap-2">
                    <OpenSiteButton site={site} />
                    {isOwner ? <RemoveSiteLink site={site} /> : null}
                  </div>
                </div>
                <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2 text-[14px] md:grid-cols-4">
                  <div><dt className="text-grey-600">Cars in today</dt><dd className="m-0 font-semibold text-navy-950">{site.todayBookings}</dd></div>
                  <div><dt className="text-grey-600">Waiting for OK</dt><dd className="m-0 font-semibold text-navy-950">{site.openRequests}</dd></div>
                  <div><dt className="text-grey-600">Revenue this month</dt><dd className="m-0 font-semibold text-navy-950">{formatWholePounds(site.revenueMonthPence)}</dd></div>
                  <div><dt className="text-grey-600">Won back</dt><dd className="m-0 font-semibold text-navy-950">{formatWholePounds(site.wonBackPence)} ({site.wonBackBookings})</dd></div>
                </dl>
              </li>
            ))}
          </ul>
        ) : null}
        {hidden > 0 ? (
          <p className="m-0 text-[14px] text-grey-700">
            {hidden === 1 ? "1 more site is" : `${hidden} more sites are`} in your group but not shown: you aren&apos;t an owner or manager there.
          </p>
        ) : null}
      </Panel>

      <Panel id="report" title="Bookings and revenue by site" className="scroll-mt-4">
        <form method="get" action={`${PATH}#report`} className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-[150px] flex-1 flex-col gap-1.5">
            <label htmlFor="report-from" className="text-[14px] font-semibold text-navy-950">From</label>
            <input id="report-from" name="from" type="date" defaultValue={range.from} className={inputClass} />
          </div>
          <div className="flex min-w-[150px] flex-1 flex-col gap-1.5">
            <label htmlFor="report-to" className="text-[14px] font-semibold text-navy-950">To</label>
            <input id="report-to" name="to" type="date" defaultValue={range.to} className={inputClass} />
          </div>
          <button type="submit" className={buttonClass("secondary", "md", "w-full sm:w-fit")}>Show</button>
        </form>
        {report && reportTotal ? (
          <>
            <DataTable
              caption={`Bookings and revenue by site, ${formatDateKey(range.from)} to ${formatDateKey(range.to)}`}
              columns={reportColumns}
              rows={[...report, { garageId: "total", name: "All sites", isHome: false, total: true, ...reportTotal }]}
              getRowKey={(row) => row.garageId}
              minWidth={300}
            />
            <p className="m-0 text-[13px] text-grey-600">
              Bookings that started in the range (not cancelled or no-shows). Revenue is invoices issued in the range, issued or paid.
            </p>
            <a href={csvHref} className={buttonClass("secondary", "md", "w-full sm:w-fit")} download>
              <Download size={16} strokeWidth={2.2} aria-hidden="true" />
              Download CSV
            </a>
          </>
        ) : (
          <SetupNotice tone="danger">The report could not be loaded. Refresh the page to try again.</SetupNotice>
        )}
      </Panel>

      {isOwner ? (
        <Panel id="add-site" title="Add a site" className="scroll-mt-4">
          <div className="flex flex-col gap-1 text-[14px] text-grey-800">
            <p className="m-0">
              The new garage gets its own booking page, diary and team, starts with the usual services and hours, and shares this group&apos;s plan.
            </p>
            <p className="m-0 font-semibold text-navy-950">
              {priceLine}. Your group now has {extraSitesLabel(extra).toLowerCase()}.
            </p>
          </div>
          {!canAdd ? (
            <SetupNotice>Only the owner of the group&apos;s home garage can add sites. Switch to the home garage to add one.</SetupNotice>
          ) : !admin.mfaVerified ? (
            <SetupNotice tone="warning">
              To add a site, verify your sign-in first.{" "}
              <Link href={`/app/mfa?returnTo=${encodeURIComponent(PATH)}&stepUp=1`} className="underline">Verify now</Link>
            </SetupNotice>
          ) : (
            <AddSiteForm linkExample={linkExample} />
          )}
        </Panel>
      ) : (
        <Panel title="More sites">
          <p className="m-0 flex items-center gap-2 text-[14px] text-grey-700">
            <Building2 size={18} strokeWidth={2} aria-hidden="true" />
            The garage owner adds and removes sites.
          </p>
        </Panel>
      )}
    </div>
  );
}
