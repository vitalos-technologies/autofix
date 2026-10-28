import { Badge, type BadgeTone } from "@/components/admin-ui";
import { STATUS_LABELS, type HealthCheckStatus } from "@/lib/health-checks/checklist";

const STATUS_TONES: Record<HealthCheckStatus, BadgeTone> = { draft: "neutral", sent: "info", responded: "success" };

/** Being checked (grey) · Sent to customer (blue) · Customer answered (green). */
export function HealthCheckStatusBadge({ status }: { status: HealthCheckStatus }) {
  return (
    <Badge tone={STATUS_TONES[status]} size="md">
      {STATUS_LABELS[status]}
    </Badge>
  );
}
