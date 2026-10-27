import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, DataTable, PageHeader, Panel, textLinkClass, type DataTableColumn } from "@/components/admin-ui";
import { importDeclaration } from "@/lib/customers/declaration";
import { listRecentImports, type CustomerImportSummary } from "@/lib/customers/queries";
import { getAdminContext } from "@/lib/tenancy/admin";
import { ImportWizard } from "./import-wizard";

export const metadata = { title: "Import customers" };

const STATUS: Record<CustomerImportSummary["status"], { label: string; tone: "success" | "info" | "danger" }> = {
  completed: { label: "Imported", tone: "success" },
  importing: { label: "In progress", tone: "info" },
  failed: { label: "Stopped", tone: "danger" },
};

export default async function ImportCustomersPage() {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) notFound();
  const canImport = admin.role === "owner" || admin.role === "manager";
  const imports = await listRecentImports(admin.client);
  const timeZone = admin.garage.timezone;

  const columns: DataTableColumn<CustomerImportSummary>[] = [
    { key: "file", header: "File", rowHeader: true, cell: (item) => <span className="break-all">{item.fileName}</span> },
    {
      key: "when",
      header: "When",
      cell: (item) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(item.createdAt)),
    },
    { key: "rows", header: "Rows", align: "right", cell: (item) => `${item.importedRows.toLocaleString("en-GB")} of ${item.totalRows.toLocaleString("en-GB")}` },
    { key: "new", header: "New customers", align: "right", cell: (item) => item.customersCreated.toLocaleString("en-GB") },
    { key: "consent", header: "Consent recorded", align: "right", cell: (item) => item.consentRecorded.toLocaleString("en-GB") },
    { key: "status", header: "Status", cell: (item) => <Badge tone={STATUS[item.status].tone}>{STATUS[item.status].label}</Badge> },
  ];

  return (
    <div className="flex flex-col gap-5">
      <Link href="/app/customers" className={textLinkClass}>
        <ArrowLeft size={18} strokeWidth={2} aria-hidden="true" className="mr-1.5" /> All customers
      </Link>
      <PageHeader
        eyebrow="Customers & cars"
        title="Import customers"
        description="Bring your customer list over from your old system. We check every row, add their cars and look up MOT dates from DVSA in the background."
      />
      {canImport ? (
        <ImportWizard declaration={importDeclaration(admin.garage.name)} motEnabled={admin.garage.motEnabled} />
      ) : (
        <Panel>
          <p className="m-0 text-[15px] text-grey-700">Only owners and managers can import customers. Ask your garage owner to do it.</p>
        </Panel>
      )}
      {imports.length ? (
        <Panel title="Recent imports">
          <DataTable caption="Recent imports" columns={columns} rows={imports} getRowKey={(item) => item.id} minWidth={680} />
        </Panel>
      ) : null}
    </div>
  );
}
