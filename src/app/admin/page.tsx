import type { Metadata } from "next";
import Link from "next/link";
import { DataTable, type DataTableColumn } from "@/components/admin-ui/data-table";
import { EmptyState } from "@/components/admin-ui/empty-state";
import { PageHeader } from "@/components/admin-ui/page-header";
import { Panel } from "@/components/admin-ui/panel";
import { buttonClass, textLinkClass } from "@/components/admin-ui/styles";
import { requirePlatformAdmin } from "@/lib/platform/access";
import { GARAGE_PLANS, GARAGE_STATUSES, isGaragePlan, isGarageStatus, PLAN_LABELS, STATUS_LABELS } from "@/lib/platform/policy";
import { listGarages, type GarageListItem } from "@/lib/platform/store";
import { DomainStatus, GarageStatusBadge, PlanBadge } from "./_components/badges";
import { formatDate, formatWhen } from "./_components/format";
import { fieldClass, labelClass } from "./_components/field-styles";

export const metadata: Metadata = { title: "Garages" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function single(value: string | string[] | undefined) {
  return typeof value === "string" ? value : undefined;
}

const columns: DataTableColumn<GarageListItem>[] = [
  {
    key: "name",
    header: "Garage",
    rowHeader: true,
    cell: (garage) => (
      <span className="flex flex-col">
        <Link href={`/admin/garages/${garage.id}`} className={textLinkClass}>{garage.name}</Link>
        <span className="text-[13px] font-normal text-grey-600">{garage.slug}</span>
      </span>
    ),
  },
  { key: "plan", header: "Plan", cell: (garage) => <PlanBadge plan={garage.plan} /> },
  { key: "status", header: "Status", cell: (garage) => <GarageStatusBadge status={garage.status} /> },
  { key: "members", header: "Team", align: "right", cell: (garage) => garage.memberCount },
  { key: "bookings", header: "Bookings 30 days", align: "right", cell: (garage) => garage.bookings30d },
  { key: "last", header: "Last booking", cell: (garage) => formatWhen(garage.lastBookingAt) },
  { key: "domain", header: "Domain", cell: (garage) => <DomainStatus hostname={garage.domainHostname} status={garage.domainStatus} /> },
  { key: "created", header: "Joined", cell: (garage) => formatDate(garage.createdAt) },
];

function pageHref(query: { q?: string; status?: string; plan?: string }, page: number) {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.status) params.set("status", query.status);
  if (query.plan) params.set("plan", query.plan);
  if (page > 1) params.set("page", String(page));
  const search = params.toString();
  return search ? `/admin?${search}` : "/admin";
}

/** Every garage on the platform: search by name or slug, filter by status and plan, 25 a page. */
export default async function PlatformGaragesPage({ searchParams }: { searchParams: SearchParams }) {
  const admin = await requirePlatformAdmin();
  const params = await searchParams;
  const q = single(params.q)?.trim().slice(0, 80) || undefined;
  const status = isGarageStatus(single(params.status)) ? (single(params.status) as (typeof GARAGE_STATUSES)[number]) : undefined;
  const plan = isGaragePlan(single(params.plan)) ? (single(params.plan) as (typeof GARAGE_PLANS)[number]) : undefined;
  const page = Math.max(1, Number.parseInt(single(params.page) ?? "1", 10) || 1);
  const result = await listGarages(admin.client, { search: q, status, plan, page });
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const query = { q, status, plan };

  return (
    <>
      <PageHeader eyebrow="Vitalos platform" title="Garages" description="Every garage on Autofix. Open one to change its plan or status, or to view it as support." />
      <Panel title="Find a garage">
        <form method="get" action="/admin" className="grid gap-3.5 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
          <div>
            <label htmlFor="garage-search" className={labelClass}>Name or slug</label>
            <input id="garage-search" name="q" type="search" defaultValue={q} maxLength={80} className={fieldClass} />
          </div>
          <div>
            <label htmlFor="garage-status" className={labelClass}>Status</label>
            <select id="garage-status" name="status" defaultValue={status ?? ""} className={fieldClass}>
              <option value="">Any status</option>
              {GARAGE_STATUSES.map((value) => <option key={value} value={value}>{STATUS_LABELS[value]}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="garage-plan" className={labelClass}>Plan</label>
            <select id="garage-plan" name="plan" defaultValue={plan ?? ""} className={fieldClass}>
              <option value="">Any plan</option>
              {GARAGE_PLANS.map((value) => <option key={value} value={value}>{PLAN_LABELS[value]}</option>)}
            </select>
          </div>
          <button type="submit" className={buttonClass("primary")}>Search</button>
        </form>
      </Panel>
      <Panel title={`${result.total} ${result.total === 1 ? "garage" : "garages"}`} padding="flush">
        <DataTable
          caption="Garages"
          columns={columns}
          rows={result.garages}
          getRowKey={(garage) => garage.id}
          minWidth={900}
          empty={<EmptyState title="No garages match" description="Try another name, or clear the filters." />}
        />
        {pages > 1 ? (
          <nav aria-label="Pages" className="flex flex-wrap items-center gap-3 pb-3">
            {result.page > 1 ? <Link href={pageHref(query, result.page - 1)} className={buttonClass("secondary", "sm")}>Previous</Link> : null}
            <span className="text-[14px] text-grey-700">Page {result.page} of {pages}</span>
            {result.page < pages ? <Link href={pageHref(query, result.page + 1)} className={buttonClass("secondary", "sm")}>Next</Link> : null}
          </nav>
        ) : null}
      </Panel>
    </>
  );
}
