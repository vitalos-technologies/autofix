import { Badge, type BadgeTone } from "@/components/admin-ui/badge";
import { PLAN_LABELS, STATUS_LABELS, type GaragePlan, type GarageStatus } from "@/lib/platform/policy";

const STATUS_TONES: Record<GarageStatus, BadgeTone> = { onboarding: "info", active: "success", suspended: "warning", cancelled: "danger" };

export function GarageStatusBadge({ status }: { status: GarageStatus }) {
  return <Badge tone={STATUS_TONES[status] ?? "neutral"}>{STATUS_LABELS[status] ?? status}</Badge>;
}

export function PlanBadge({ plan }: { plan: GaragePlan }) {
  return <Badge tone="neutral">{PLAN_LABELS[plan] ?? plan}</Badge>;
}

const DOMAIN_LABELS: Record<string, string> = { pending_dns: "Waiting for DNS", verifying: "Verifying", active: "Live", failed: "Failed" };

export function DomainStatus({ hostname, status }: { hostname: string | null; status: string | null }) {
  if (!hostname || !status) return <span className="text-grey-600">Free link only</span>;
  return (
    <span className="flex flex-col gap-1">
      <span className="break-all">{hostname}</span>
      <Badge tone={status === "active" ? "success" : status === "failed" ? "danger" : "warning"} size="xs">{DOMAIN_LABELS[status] ?? status}</Badge>
    </span>
  );
}
