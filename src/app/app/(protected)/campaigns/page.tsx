import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Megaphone } from "lucide-react";
import {
  buttonClass,
  DataTable,
  EmptyState,
  KpiCard,
  KpiGrid,
  PageHeader,
  Panel,
  StatusPill,
  textLinkClass,
  type DataTableColumn,
} from "@/components/admin-ui";
import { ProLockedPage } from "@/components/plans";
import { DEFAULT_TIME_ZONE } from "@/lib/admin/dates";
import { formatWholePounds } from "@/lib/admin/today";
import { EMPTY_RESULTS, loadCampaignResults, loadCampaigns, totalResults, type Campaign, type CampaignResults } from "@/lib/campaigns/admin";
import { availableStarters } from "@/lib/campaigns/templates";
import { campaignStatusPill, formatSendTime } from "@/lib/campaigns/view";
import { garageHasFeature } from "@/lib/plans/server";
import { canManageSetup } from "@/lib/settings/setup";
import { getAdminContext } from "@/lib/tenancy/admin";
import { cn } from "@/lib/utils";
import { FlashMessage, ReadOnlyNotice } from "../settings/_components/setup-nav";

export const metadata: Metadata = { title: "Campaigns" };

type PageProps = { searchParams: Promise<{ done?: string | string[]; error?: string | string[] }> };

const MESSAGES: Record<string, string> = {
  "done:deleted": "Draft deleted.",
  "error:not_allowed": "Only the garage's owners and managers can change campaigns.",
  "error:not_found": "That campaign could not be found.",
  "error:plan_required": "Campaigns are part of Pro.",
};

type Row = Campaign & { results: CampaignResults };

function columns(timeZone: string): DataTableColumn<Row>[] {
  return [
    {
      key: "name",
      header: "Campaign",
      rowHeader: true,
      cell: (row) => (
        <Link href={`/app/campaigns/${row.id}`} className={cn(textLinkClass, "-my-[11px] font-semibold text-inherit")}>
          {row.name}
        </Link>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (row) => {
        const pill = campaignStatusPill(row.status);
        return <StatusPill status={pill.status} label={pill.label} size="sm" />;
      },
    },
    { key: "when", header: "Sends", cell: (row) => (row.sendAt ? formatSendTime(row.sendAt, timeZone) : "Not scheduled") },
    { key: "sent", header: "Sent", cell: (row) => (row.status === "draft" ? "–" : String(row.results.sent)) },
    { key: "bookings", header: "Bookings", cell: (row) => String(row.results.bookings) },
    { key: "won", header: "Won", cell: (row) => formatWholePounds(row.results.pence) },
  ];
}

/** Campaigns (P5.5, Pro): results so far, ready-made starting points and every campaign. */
export default async function CampaignsPage({ searchParams }: PageProps) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  const query = await searchParams;
  const timeZone = admin.garage.timezone || DEFAULT_TIME_ZONE;
  const canEdit = canManageSetup(admin.role);
  const [campaigns, results] = await Promise.all([loadCampaigns(admin.client, admin.garage.id), loadCampaignResults(admin.client)]);
  const rows: Row[] = (campaigns ?? []).map((campaign) => ({ ...campaign, results: results?.get(campaign.id) ?? EMPTY_RESULTS }));

  const table =
    rows.length > 0 ? (
      <DataTable caption="Campaigns, newest first" columns={columns(timeZone)} rows={rows} getRowKey={(row) => row.id} minWidth={640} />
    ) : (
      <EmptyState icon={Megaphone} title="No campaigns yet" description="Start from one of the ideas above, or write your own." />
    );

  if (!garageHasFeature(admin.garage, "campaigns")) {
    return (
      <div className="flex flex-col gap-[22px] pb-10">
        <ProLockedPage feature="campaigns" title="Campaigns" canUpgrade={admin.role === "owner"} hasExistingData={rows.length > 0} />
        {rows.length > 0 ? (
          <Panel title="Earlier campaigns" className="gap-2.5">
            {table}
          </Panel>
        ) : null}
      </div>
    );
  }

  const total = totalResults(rows.map((row) => row.results));
  const starters = availableStarters(admin.garage.motEnabled);

  return (
    <div className="flex flex-col gap-[22px] pb-10">
      <PageHeader
        title="Campaigns"
        description="Seasonal offers, win-backs and MOT months, to customers who agreed to hear from you. Every message has a one-tap opt-out."
        actions={
          canEdit ? (
            <Link href="/app/campaigns/new" className={buttonClass("primary")}>
              New campaign
            </Link>
          ) : undefined
        }
      />
      <FlashMessage messages={MESSAGES} done={query.done} error={query.error} />
      {!canEdit ? <ReadOnlyNotice level="manage" /> : null}

      {results ? (
        <KpiGrid label="All campaigns">
          <KpiCard size="sm" label="Messages sent" value={String(total.sent)} />
          <KpiCard size="sm" label="Links opened" value={String(total.opened)} />
          <KpiCard size="sm" label="Bookings won" value={String(total.bookings)} />
          <KpiCard size="sm" label="Revenue won" value={formatWholePounds(total.pence)} tone="navy" />
        </KpiGrid>
      ) : (
        <p role="alert" className="m-0 text-[14px] font-semibold text-[#991b1b]">
          The campaign results could not be loaded. Refresh the page to try again.
        </p>
      )}

      {canEdit ? (
        <Panel title="Start from an idea" className="gap-3">
          <ul className="m-0 grid list-none grid-cols-1 gap-2.5 p-0 sm:grid-cols-2 xl:grid-cols-4">
            {starters.map((starter) => (
              <li key={starter.key} className="flex">
                <Link
                  href={`/app/campaigns/new?starter=${starter.key}`}
                  className="flex min-h-11 w-full flex-col gap-1 rounded-[12px] border border-grey-300 bg-white p-3.5 text-navy-950 hover:border-grey-600 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <span className="flex items-center justify-between gap-2 text-[15px] font-bold">
                    {starter.title}
                    <ArrowRight size={18} strokeWidth={2} aria-hidden="true" />
                  </span>
                  <span className="text-[13px] leading-snug text-grey-700">{starter.description}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel title="Your campaigns" className="gap-2.5">
        {campaigns ? (
          table
        ) : (
          <p role="alert" className="m-0 text-[14px] font-semibold text-[#991b1b]">
            The campaigns could not be loaded. Refresh the page to try again.
          </p>
        )}
      </Panel>
    </div>
  );
}
