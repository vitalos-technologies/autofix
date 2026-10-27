import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DataTable } from "@/components/admin-ui/data-table";
import { KpiCard, KpiGrid } from "@/components/admin-ui/kpi-card";
import { PageHeader } from "@/components/admin-ui/page-header";
import { Panel } from "@/components/admin-ui/panel";
import { textLinkClass } from "@/components/admin-ui/styles";
import { requirePlatformAdmin } from "@/lib/platform/access";
import { getGarage, listAuditEntries, type AuditEntry } from "@/lib/platform/store";
import { DomainStatus, GarageStatusBadge, PlanBadge } from "../../_components/badges";
import { formatDate, formatWhen } from "../../_components/format";
import { GarageChangeForm, ImpersonateForm } from "../../_components/forms";

export const metadata: Metadata = { title: "Garage" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACTION_LABELS: Record<string, string> = {
  "platform.garage_plan_changed": "Plan changed",
  "platform.garage_status_changed": "Status changed",
  "platform.impersonation_started": "Support session started",
  "platform.impersonation_ended": "Support session ended",
  "platform.impersonation_expired": "Support session expired",
  "platform.impersonation_page_view": "Page viewed as support",
  "platform.impersonation_write_blocked": "Change blocked (read-only)",
  "platform.job_retried": "Job retried",
};

function describe(entry: AuditEntry) {
  const detail = entry.detail ?? {};
  if (typeof detail.from === "string" && typeof detail.to === "string") return `${detail.from} → ${detail.to}`;
  if (typeof detail.path === "string") return detail.path;
  if (typeof detail.end_reason === "string") return detail.end_reason;
  return "";
}

/** One garage: plan and status (with a reason, audited), a read-only support session, and its platform history. */
export default async function PlatformGaragePage({ params }: { params: Promise<{ garageId: string }> }) {
  const admin = await requirePlatformAdmin();
  const { garageId } = await params;
  if (!UUID.test(garageId)) notFound();
  const [garage, audit] = await Promise.all([getGarage(admin.client, garageId), listAuditEntries(admin.client, garageId, 30)]);
  if (!garage) notFound();
  const team = garage.members.owner + garage.members.manager + garage.members.technician;

  return (
    <>
      <p className="m-0"><Link href="/admin" className={textLinkClass}>All garages</Link></p>
      <PageHeader
        eyebrow={garage.slug}
        title={garage.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <PlanBadge plan={garage.plan} />
            <GarageStatusBadge status={garage.status} />
            <span>Joined {formatDate(garage.created_at)}</span>
            {garage.cancelled_at ? <span>· Cancelled {formatDate(garage.cancelled_at)}</span> : null}
          </span>
        }
      />
      <KpiGrid>
        <KpiCard label="Team" value={String(team)} context={`${garage.members.owner} owner · ${garage.members.manager} manager · ${garage.members.technician} technician`} />
        <KpiCard label="Bookings, 30 days" value={String(garage.bookings_30d)} context={`Last ${formatWhen(garage.last_booking_at)}`} />
        <KpiCard label="MOT" value={garage.mot_enabled ? "On" : "Off"} context={garage.timezone} />
      </KpiGrid>
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel id="plan-status" title="Plan and status">
          <p className="m-0 text-[14px] text-grey-700">
            Suspended and cancelled garages stop taking bookings: the booking site answers &ldquo;page not found&rdquo; (within a minute), the
            agent API refuses calls and no new slots are offered. Cancelled garages also disappear from their team&apos;s admin.
          </p>
          <GarageChangeForm garageId={garage.id} plan={garage.plan} status={garage.status} />
        </Panel>
        <Panel id="view-as-support" title="View as support">
          <p className="m-0 text-[14px] text-grey-700">
            Opens this garage&apos;s admin for you, read-only, for a limited time. Every page you open is listed in the garage&apos;s
            own audit log with your reason, and the owners can see it.
          </p>
          <ImpersonateForm garageId={garage.id} />
        </Panel>
      </div>
      <Panel title="Domains" padding="flush">
        <DataTable
          caption="Domains"
          columns={[
            { key: "host", header: "Domain", rowHeader: true, cell: (domain) => <DomainStatus hostname={domain.hostname} status={domain.status} /> },
            { key: "kind", header: "Kind", cell: (domain) => (domain.kind === "custom" ? "Own domain" : "Free link") },
            { key: "checked", header: "Last checked", cell: (domain) => formatWhen(domain.last_checked_at) },
          ]}
          rows={garage.domains}
          getRowKey={(domain) => domain.hostname}
          minWidth={520}
        />
      </Panel>
      <Panel title="Support sessions" padding="flush">
        <DataTable
          caption="Support sessions"
          columns={[
            { key: "started", header: "Started", rowHeader: true, cell: (session) => formatWhen(session.started_at) },
            { key: "admin", header: "By", cell: (session) => session.admin },
            { key: "reason", header: "Reason", cell: (session) => <span className="break-words">{session.reason}</span> },
            { key: "end", header: "Ended", cell: (session) => (session.ended_at ? `${formatWhen(session.ended_at)} (${session.end_reason})` : `Open until ${formatWhen(session.expires_at)}`) },
          ]}
          rows={garage.impersonations}
          getRowKey={(session) => session.id}
          minWidth={640}
        />
      </Panel>
      <Panel title="Platform history" padding="flush">
        <DataTable
          caption="Platform history"
          columns={[
            { key: "when", header: "When", rowHeader: true, cell: (entry) => formatWhen(entry.created_at) },
            { key: "action", header: "What", cell: (entry) => ACTION_LABELS[entry.action] ?? entry.action },
            { key: "detail", header: "Detail", cell: (entry) => <span className="break-all">{describe(entry)}</span> },
            { key: "reason", header: "Reason", cell: (entry) => entry.reason ?? "" },
            { key: "who", header: "By", cell: (entry) => entry.actor_name },
          ]}
          rows={audit}
          getRowKey={(entry) => String(entry.id)}
          minWidth={760}
        />
      </Panel>
    </>
  );
}
