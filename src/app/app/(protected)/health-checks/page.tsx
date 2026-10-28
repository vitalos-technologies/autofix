import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight, ClipboardCheck } from "lucide-react";
import { EmptyState, PageHeader, Panel, buttonClass } from "@/components/admin-ui";
import { formatSlotLabel } from "@/components/book/format";
import { PlateChip } from "@/components/book/plate-chip";
import { Notice } from "@/components/onboarding/field";
import { ProLockedPage } from "@/components/plans";
import { formatPounds } from "@/lib/health-checks/checklist";
import { HealthCheckDataError, listHealthChecks } from "@/lib/health-checks/server";
import { healthCheckStatusLine, type HealthCheckSummary } from "@/lib/health-checks/view";
import { planRequiredMessage } from "@/lib/plans/entitlements";
import { garageHasFeature } from "@/lib/plans/server";
import { getAdminContext } from "@/lib/tenancy/admin";
import { cn } from "@/lib/utils";
import { HealthCheckStatusBadge } from "./_components/status-badge";

export const metadata: Metadata = { title: "Health checks" };

const NOTICES: Record<string, { tone: "error" | "warning"; text: string }> = {
  not_found: { tone: "error", text: "That booking could not be found." },
  booking_closed: { tone: "warning", text: "That booking is cancelled or was missed, so it can't have a health check." },
  plan: { tone: "warning", text: planRequiredMessage("health_checks") },
};

function CheckRow({ check, timeZone }: { check: HealthCheckSummary; timeZone: string }) {
  return (
    <li className="border-t border-grey-200 first:border-t-0">
      <Link
        href={`/app/health-checks/${check.id}`}
        className="flex min-h-[64px] items-center gap-3 py-3 no-underline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-accent focus-visible:outline-solid"
      >
        <span className="flex min-w-0 grow flex-col gap-1.5">
          <span className="flex flex-wrap items-center gap-2">
            {check.registration ? <PlateChip registration={check.registration} /> : null}
            <span className="text-[15px] font-bold text-navy-950">{check.customerName ?? "Customer"}</span>
            <span className="text-[13px] text-grey-600">{check.reference}</span>
          </span>
          <span className="text-[13.5px] text-grey-700">
            {[check.vehicleName, check.startsAt ? formatSlotLabel(check.startsAt, timeZone) : null].filter(Boolean).join(" · ")}
          </span>
          <span className={cn("text-[13.5px] font-semibold", check.status === "responded" && check.approvedTotalPence > 0 ? "text-success-ink" : "text-grey-700")}>
            {healthCheckStatusLine(check, formatPounds)}
          </span>
        </span>
        <HealthCheckStatusBadge status={check.status} />
        <ChevronRight size={20} strokeWidth={2} aria-hidden="true" className="shrink-0 text-grey-600" />
      </Link>
    </li>
  );
}

/**
 * Health checks (P5.3, Pro): every check of the garage, newest first. A check is started from its
 * booking ("Start health check"). Essentials garages see the Pro card, and any checks they made on
 * Pro stay listed, read-only.
 */
export default async function HealthChecksPage({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  const timeZone = admin.garage.timezone || "Europe/London";
  const notice = NOTICES[(await searchParams).notice ?? ""] ?? null;
  let checks: HealthCheckSummary[] | null = null;
  try {
    checks = await listHealthChecks(admin.client);
  } catch (error) {
    if (!(error instanceof HealthCheckDataError)) throw error;
  }

  const list = checks && checks.length > 0 ? (
    <Panel title="Health checks" count={checks.length} countLabel="health checks" padding="flush">
      <ul className="m-0 list-none p-0">
        {checks.map((check) => (
          <CheckRow key={check.id} check={check} timeZone={timeZone} />
        ))}
      </ul>
    </Panel>
  ) : null;

  if (!garageHasFeature(admin.garage, "health_checks")) {
    return (
      <div className="flex flex-col gap-5 pb-10">
        <ProLockedPage feature="health_checks" title="Health checks" canUpgrade={admin.role === "owner"} hasExistingData={Boolean(checks?.length)} />
        {list}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 pb-10">
      <PageHeader
        eyebrow="Workshop"
        title="Health checks"
        description="Red, amber and green checks with photos and video. Customers see them on their phone and approve extra work online."
      />
      {notice ? <Notice tone={notice.tone} role="alert">{notice.text}</Notice> : null}
      {checks === null ? (
        <Notice tone="error" role="alert">Health checks could not be loaded. Refresh the page to try again.</Notice>
      ) : (
        list ?? (
          <EmptyState
            tone="card"
            icon={ClipboardCheck}
            title="No health checks yet"
            description="Open a booking and press Start health check while the car is in."
            action={<Link href="/app/bookings" className={buttonClass("primary", "md")}>Go to bookings</Link>}
          />
        )
      )}
    </div>
  );
}
