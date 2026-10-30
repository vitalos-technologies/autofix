import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Panel } from "@/components/admin-ui";
import { PlateChip } from "@/components/book/plate-chip";
import { formatPounds } from "@/lib/health-checks/checklist";
import type { RecentApproval } from "@/lib/health-checks/server";

/** Today (P5.3): health checks customers answered today with work approved. Nothing when there are none. */
export function HealthCheckApprovalsPanel({ id, approvals, className }: { id: string; approvals: readonly RecentApproval[]; className?: string }) {
  if (approvals.length === 0) return null;
  return (
    <Panel id={id} title="Approved on health checks" count={approvals.length} countLabel={`${approvals.length} approved today`} className={className}>
      <ul className="m-0 flex list-none flex-col p-0">
        {approvals.map((approval) => (
          <li key={approval.id} className="border-t border-[#f1f5f9] first:border-t-0">
            <Link
              href={`/app/health-checks/${approval.id}`}
              className="flex min-h-11 items-center gap-2.5 py-2.5 no-underline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-accent focus-visible:outline-solid"
            >
              {approval.registration ? <PlateChip registration={approval.registration} /> : null}
              <span className="flex min-w-0 grow flex-col">
                <span className="truncate text-[14px] font-bold text-navy-950">{approval.customerName ?? approval.reference ?? "Customer"}</span>
                <span className="text-[13.5px] font-semibold text-success-ink">Customer approved {formatPounds(approval.approvedTotalPence)}</span>
              </span>
              <ChevronRight size={18} strokeWidth={2} aria-hidden="true" className="shrink-0 text-grey-600" />
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
