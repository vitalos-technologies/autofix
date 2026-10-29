import { CheckCircle2 } from "lucide-react";
import { formatLegalDate, renderDpa, type LegalGarage } from "@/lib/legal/documents";
import type { DpaStatus } from "@/lib/legal/agreements";
import { DpaAcceptForm } from "./dpa-accept-form";
import { DraftFlag, LegalDocumentBody } from "./legal-document";

type DpaAcceptanceProps = {
  garage: Pick<LegalGarage, "name" | "legalName">;
  status: DpaStatus;
  /** Owners accept; everyone else reads. */
  canAccept: boolean;
};

/**
 * The garage's Data Processing Agreement with Vitalos and its acceptance.
 * Used by /app/settings/agreements; the sign-up flow (P4.4) renders the same
 * component for the new garage's owner.
 */
export function DpaAcceptance({ garage, status, canAccept }: DpaAcceptanceProps) {
  const document = renderDpa(garage, status.current);
  const legalName = garage.legalName?.trim() || garage.name;
  return (
    <section aria-labelledby="dpa-heading" className="grid gap-4">
      <div>
        <h2 id="dpa-heading" className="text-2xl font-bold text-[#0f2747]">{document.title}</h2>
        <p className="mt-1 text-sm text-[#64748b]">Version {document.version}</p>
      </div>
      <DraftFlag document={document} />
      {status.current ? (
        <p role="status" className="m-0 flex items-start gap-2 rounded-xl border border-green-200 bg-green-50 p-4 text-sm font-bold text-green-900">
          <CheckCircle2 size={19} aria-hidden="true" className="shrink-0" />
          Accepted on {formatLegalDate(status.current.acceptedAt)} by {status.current.acceptedByName}.
        </p>
      ) : (
        <p className="m-0 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm font-bold text-amber-900">
          {canAccept ? "Please read and accept this agreement before taking bookings." : "The garage owner has not accepted this agreement yet."}
        </p>
      )}
      <div tabIndex={0} aria-label="Agreement text" className="max-h-[60vh] overflow-y-auto rounded-2xl border border-[#E2E8F0] bg-white p-5 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB]">
        <LegalDocumentBody document={document} />
      </div>
      {!status.current && canAccept ? <DpaAcceptForm version={document.version} legalName={legalName} /> : null}
      {status.history.some((record) => record.version !== status.currentVersion) ? (
        <div>
          <h3 className="text-base font-bold text-[#0f2747]">Earlier versions</h3>
          <ul className="mt-2 grid gap-1 text-sm text-[#64748b]">
            {status.history
              .filter((record) => record.version !== status.currentVersion)
              .map((record) => (
                <li key={record.version}>
                  Version {record.version}: accepted on {formatLegalDate(record.acceptedAt)} by {record.acceptedByName}
                </li>
              ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
