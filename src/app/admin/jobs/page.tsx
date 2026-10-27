import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/admin-ui/badge";
import { DataTable } from "@/components/admin-ui/data-table";
import { EmptyState } from "@/components/admin-ui/empty-state";
import { KpiCard, KpiGrid } from "@/components/admin-ui/kpi-card";
import { PageHeader } from "@/components/admin-ui/page-header";
import { Panel } from "@/components/admin-ui/panel";
import { textLinkClass } from "@/components/admin-ui/styles";
import { requirePlatformAdmin } from "@/lib/platform/access";
import { getJobHealth } from "@/lib/platform/store";
import { formatAge, formatWhen } from "../_components/format";
import { RetryJobForm } from "../_components/forms";

export const metadata: Metadata = { title: "Job health" };

type KindRow = { kind: string; queued: number; running: number; done: number; failed: number };

/** The job queue (P3.6) at a glance: counts, waiting time, stuck locks, failures (redacted) and reminder problems. */
export default async function PlatformJobsPage() {
  const admin = await requirePlatformAdmin();
  const health = await getJobHealth(admin.client);
  const kinds = new Map<string, KindRow>();
  for (const entry of health.byKind) {
    const row = kinds.get(entry.kind) ?? { kind: entry.kind, queued: 0, running: 0, done: 0, failed: 0 };
    row[entry.status] = entry.count;
    kinds.set(entry.kind, row);
  }
  const kindRows = [...kinds.values()];
  const total = (status: keyof Omit<KindRow, "kind">) => kindRows.reduce((sum, row) => sum + row[status], 0);

  return (
    <>
      <PageHeader eyebrow="Vitalos platform" title="Job health" description={`Background jobs and reminder sends. Checked ${formatWhen(health.generatedAt)}.`} />
      <KpiGrid label="Queue">
        <KpiCard label="Queued" value={String(total("queued"))} context={`Oldest waiting ${formatAge(health.oldestQueuedAt)}`} />
        <KpiCard label="Running" value={String(total("running"))} context={`${health.expiredLocks.length} with an expired lock`} />
        <KpiCard label="Failed" value={String(total("failed"))} context="Retry below once fixed" />
        <KpiCard label="Done" value={String(total("done"))} context="All time" />
      </KpiGrid>
      <Panel title="By kind" padding="flush">
        <DataTable
          caption="Jobs by kind"
          columns={[
            { key: "kind", header: "Kind", rowHeader: true, cell: (row) => <code className="font-mono text-[13px]">{row.kind}</code> },
            { key: "queued", header: "Queued", align: "right", cell: (row) => row.queued },
            { key: "running", header: "Running", align: "right", cell: (row) => row.running },
            { key: "failed", header: "Failed", align: "right", cell: (row) => (row.failed ? <Badge tone="danger">{row.failed}</Badge> : 0) },
            { key: "done", header: "Done", align: "right", cell: (row) => row.done },
          ]}
          rows={kindRows}
          getRowKey={(row) => row.kind}
          minWidth={520}
          empty={<EmptyState title="No jobs yet" />}
        />
      </Panel>
      <Panel title="Running with an expired lock" count={health.expiredLocks.length} padding="flush">
        <DataTable
          caption="Running jobs with an expired lock"
          columns={[
            { key: "kind", header: "Kind", rowHeader: true, cell: (job) => <code className="font-mono text-[13px]">{job.kind}</code> },
            { key: "attempts", header: "Attempts", cell: (job) => `${job.attempts} of ${job.max_attempts}` },
            { key: "lock", header: "Lock ran out", cell: (job) => formatWhen(job.locked_until) },
          ]}
          rows={health.expiredLocks}
          getRowKey={(job) => job.id}
          minWidth={480}
          empty={<EmptyState title="None" description="The next worker run picks these up again, or fails them after their last attempt." />}
        />
      </Panel>
      <Panel title="Recent failures" count={health.recentFailures.length}>
        {health.recentFailures.length === 0 ? (
          <EmptyState title="No failed jobs" />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {health.recentFailures.map((failure) => (
              <li key={failure.id} className="flex flex-col gap-3 rounded-input border border-grey-200 p-3.5 lg:flex-row lg:items-start">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="m-0 flex flex-wrap items-center gap-2">
                    <code className="font-mono text-[14px] font-semibold text-navy-950">{failure.kind}</code>
                    <span className="text-[13px] text-grey-600">
                      {formatWhen(failure.finishedAt)} · {failure.attempts} of {failure.maxAttempts} attempts
                    </span>
                  </p>
                  {failure.garageId ? (
                    <p className="m-0 text-[14px]">
                      <Link href={`/admin/garages/${failure.garageId}`} className={textLinkClass}>{failure.garageName ?? "Garage"}</Link>
                    </p>
                  ) : null}
                  <p className="m-0 font-mono text-[13px] break-words whitespace-pre-wrap text-grey-800">{failure.error || "No error recorded"}</p>
                </div>
                <div className="w-full lg:w-[280px]"><RetryJobForm jobId={failure.id} kind={failure.kind} /></div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="Reminder sends skipped or failed, last 7 days" padding="flush">
        <DataTable
          caption="Reminder sends skipped or failed in the last 7 days"
          columns={[
            { key: "garage", header: "Garage", rowHeader: true, cell: (row) => <Link href={`/admin/garages/${row.garageId}`} className={textLinkClass}>{row.garageName}</Link> },
            { key: "skipped", header: "Skipped", align: "right", cell: (row) => row.skipped },
            { key: "failed", header: "Failed", align: "right", cell: (row) => (row.failed ? <Badge tone="danger">{row.failed}</Badge> : 0) },
          ]}
          rows={health.reminderSends7d}
          getRowKey={(row) => row.garageId}
          minWidth={420}
          empty={<EmptyState title="None" description="No reminder was skipped or failed this week." />}
        />
      </Panel>
    </>
  );
}
