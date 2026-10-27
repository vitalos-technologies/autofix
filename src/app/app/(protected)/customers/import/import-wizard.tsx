"use client";

import { AlertTriangle, CheckCircle2, FileSpreadsheet, LoaderCircle, Upload } from "lucide-react";
import Link from "next/link";
import { useId, useRef, useState, useTransition } from "react";
import { Badge, buttonClass, DataTable, focusRing, Panel, type DataTableColumn } from "@/components/admin-ui";
import { PlateChip } from "@/components/book/plate-chip";
import { formatUkMobile, MAX_IMPORT_BYTES, type ImportIssue } from "@/lib/customers/csv";
import { cn } from "@/lib/utils";
import { importCustomersAction, previewCustomerImportAction, type ImportFailure, type ImportOutcome, type ImportPreview } from "../actions";

export type ImportWizardProps = {
  /** The declaration wording with the garage's name (stored as the consent text). */
  declaration: string;
  motEnabled: boolean;
};

// Drama-range numbers (Ofcom 07700 900xxx) so the template never reaches a real phone.
const TEMPLATE = [
  "Name,Mobile,Email,Registration,Consent",
  "Sam Driver,07700 900123,sam@example.com,AB12 CDE,yes",
  "Alex Owner,07700 900456,,XY65 ZZZ,no",
].join("\r\n");
const TEMPLATE_HREF = `data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`;

const FIELD_LABELS: Record<ImportIssue["field"], string> = {
  name: "Name",
  mobile: "Mobile",
  email: "Email",
  registration: "Registration",
  consent: "Consent",
  row: "Row",
};

const COLUMN_LABELS: Array<[keyof ImportPreview["columns"], string]> = [
  ["name", "Name"],
  ["firstName", "First name"],
  ["lastName", "Last name"],
  ["mobile", "Mobile"],
  ["email", "Email"],
  ["registration", "Registration"],
  ["consent", "Consent"],
];

type ChosenFile = { fileName: string; csv: string };

function Stat({ label, value, tone = "plain" }: { label: string; value: number; tone?: "plain" | "warning" | "success" }) {
  return (
    <div className={cn(
      "flex flex-col gap-1 rounded-input border px-3.5 py-3",
      tone === "warning" ? "border-[#f3d9a4] bg-warning-bg" : tone === "success" ? "border-[#bfe5cc] bg-success-bg" : "border-grey-200 bg-white",
    )}>
      <span className="font-display text-[26px] leading-none font-extrabold text-navy-950">{value.toLocaleString("en-GB")}</span>
      <span className="text-[13px] font-semibold text-grey-700">{label}</span>
    </div>
  );
}

const issueColumns: DataTableColumn<ImportIssue>[] = [
  { key: "row", header: "Row", rowHeader: true, cell: (issue) => issue.row },
  { key: "field", header: "Column", cell: (issue) => FIELD_LABELS[issue.field] },
  { key: "message", header: "Problem", cell: (issue) => issue.message },
];

/** Upload → check → declaration → import. The file is read in the browser and posted to server actions. */
export function ImportWizard({ declaration, motEnabled }: ImportWizardProps) {
  const inputId = useId();
  const declarationId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<ChosenFile | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [declared, setDeclared] = useState(false);
  const [declarationError, setDeclarationError] = useState(false);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [checking, startChecking] = useTransition();
  const [importing, startImporting] = useTransition();

  const reset = () => {
    setFile(null);
    setPreview(null);
    setFailure(null);
    setDeclared(false);
    setDeclarationError(false);
    setOutcome(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const choose = async (chosen: File | undefined) => {
    setPreview(null);
    setFailure(null);
    setOutcome(null);
    setDeclared(false);
    if (!chosen) return;
    if (chosen.size > MAX_IMPORT_BYTES) {
      setFailure("The file is larger than 2 MB. Split it into smaller files.");
      return;
    }
    const next = { fileName: chosen.name, csv: await chosen.text() };
    setFile(next);
    startChecking(async () => {
      const result: ImportPreview | ImportFailure = await previewCustomerImportAction(next);
      if (result.ok) setPreview(result);
      else setFailure(result.message);
    });
  };

  const runImport = () => {
    if (!file || !preview || importing) return;
    if (!declared) {
      setDeclarationError(true);
      document.getElementById(declarationId)?.focus();
      return;
    }
    startImporting(async () => {
      const result = await importCustomersAction({ ...file, declarationAccepted: true });
      if (result.ok) {
        setOutcome(result);
        setFailure(null);
      } else {
        setFailure(result.message);
      }
    });
  };

  if (outcome) {
    const { counts } = outcome;
    return (
      <Panel title="Import finished" leading={<CheckCircle2 size={22} strokeWidth={2} aria-hidden="true" className="text-[#15803d]" />}>
        <p role="status" className="m-0 text-[15px] text-grey-700">
          {outcome.importedRows.toLocaleString("en-GB")} rows imported in {(outcome.durationMs / 1000).toFixed(1)} seconds
          {outcome.skippedRows ? `; ${outcome.skippedRows.toLocaleString("en-GB")} skipped` : ""}.
          {motEnabled ? " MOT dates are being looked up from DVSA in the background." : " Car details are being looked up from DVSA in the background."}
        </p>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <Stat label="New customers" value={counts.customersCreated} tone="success" />
          <Stat label="Customers updated" value={counts.customersUpdated} />
          <Stat label="Cars added" value={counts.vehiclesCreated} />
          <Stat label="Consent recorded" value={counts.consentRecorded} />
        </div>
        <div className="flex flex-wrap gap-2.5">
          <Link href="/app/customers" className={buttonClass("primary")}>View customers</Link>
          <button type="button" onClick={reset} className={buttonClass("secondary")}>Import another file</button>
        </div>
      </Panel>
    );
  }

  const sampleColumns: DataTableColumn<ImportPreview["sample"][number]>[] = [
    { key: "row", header: "Row", cell: (row) => row.row },
    { key: "name", header: "Name", rowHeader: true, cell: (row) => row.name },
    { key: "mobile", header: "Mobile", cell: (row) => <span className="whitespace-nowrap">{formatUkMobile(row.phone)}</span> },
    { key: "reg", header: "Registration", cell: (row) => row.registration ? <PlateChip registration={row.registration} /> : <span className="text-grey-600">None</span> },
    { key: "consent", header: "Consent", cell: (row) => row.consent ? <Badge tone="success">Yes</Badge> : <Badge tone="muted">No</Badge> },
  ];

  return (
    <div className="flex flex-col gap-5">
      <Panel title="1. Choose your file">
        <p className="m-0 text-[14px] text-grey-700">
          A CSV with a heading row: <strong>name</strong> and <strong>mobile</strong> are needed; <strong>email</strong>, <strong>registration</strong> and <strong>consent</strong> (yes or no) are optional.
          Most column names work (Customer, Phone, Reg, VRM…). Save from Excel or Google Sheets as CSV.{" "}
          <a href={TEMPLATE_HREF} download="customers-template.csv" className="font-semibold text-accent underline underline-offset-2">Download a template</a>
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor={inputId} className={cn(buttonClass("secondary"), "cursor-pointer has-[:focus-visible]:ring-4")}>
            <FileSpreadsheet size={18} strokeWidth={2} aria-hidden="true" /> {file ? "Choose a different file" : "Choose CSV file"}
          </label>
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            onChange={(event) => void choose(event.target.files?.[0])}
          />
          {file ? <span className="text-[14px] font-semibold break-all text-navy-950">{file.fileName}</span> : null}
          {checking ? (
            <span role="status" className="inline-flex items-center gap-2 text-[14px] text-grey-700">
              <LoaderCircle size={18} strokeWidth={2} aria-hidden="true" className="animate-spin" /> Checking your file…
            </span>
          ) : null}
        </div>
        {failure ? (
          <p role="alert" className="m-0 flex items-start gap-2 rounded-input bg-[#fdecec] px-3.5 py-3 text-[14px] text-[#991b1b]">
            <AlertTriangle size={18} strokeWidth={2} aria-hidden="true" className="mt-px shrink-0" /> {failure}
          </p>
        ) : null}
      </Panel>

      {preview ? (
        <>
          <Panel title="2. Check what we found">
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Rows in file" value={preview.totalRows} />
              <Stat label="Customers to import" value={preview.customers} tone="success" />
              <Stat label="Cars" value={preview.vehicles} />
              <Stat label="With consent" value={preview.consenting} />
              <Stat label="Rows with problems" value={preview.errorRows} tone={preview.errorRows ? "warning" : "plain"} />
              <Stat label="Duplicates skipped" value={preview.duplicates} />
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[14px] text-grey-700">
              <span className="font-semibold text-navy-950">Columns used:</span>
              {COLUMN_LABELS.filter(([field]) => preview.columns[field]).map(([field, label]) => (
                <Badge key={field} tone="info">{label} ← {preview.columns[field]}</Badge>
              ))}
            </div>
            {!preview.hasConsentColumn ? (
              <p className="m-0 text-[14px] text-grey-700">Your file has no consent column, so the declaration below covers every customer in it.</p>
            ) : null}
            {preview.sample.length ? (
              <DataTable caption="First rows to import" showCaption columns={sampleColumns} rows={preview.sample} getRowKey={(row) => String(row.row)} minWidth={560} />
            ) : null}
            {preview.errors.length ? (
              <div className="flex flex-col gap-2">
                <h3 className="m-0 text-[15px] font-bold text-navy-950">Rows that will be skipped</h3>
                <p className="m-0 text-[14px] text-grey-700">Fix these in your spreadsheet and import the file again, or import now and add them later. Row numbers match your spreadsheet.</p>
                <DataTable caption="Problems by row" columns={issueColumns} rows={preview.errors} getRowKey={(issue) => `${issue.row}-${issue.field}`} minWidth={420} maxHeight={320} variant="tinted" />
                {preview.errorRows > preview.errors.length ? <p className="m-0 text-[13px] text-grey-600">Showing the first {preview.errors.length} problems.</p> : null}
              </div>
            ) : null}
            {preview.warnings.length ? (
              <div className="flex flex-col gap-2">
                <h3 className="m-0 text-[15px] font-bold text-navy-950">Imported with changes</h3>
                <DataTable caption="Warnings by row" columns={issueColumns} rows={preview.warnings} getRowKey={(issue) => `${issue.row}-${issue.field}`} minWidth={420} maxHeight={240} variant="tinted" />
              </div>
            ) : null}
          </Panel>

          <Panel title="3. Confirm consent and import" highlight={preview.validRows > 0}>
            <div className="flex items-start gap-3">
              <input
                id={declarationId}
                type="checkbox"
                checked={declared}
                required
                aria-invalid={declarationError || undefined}
                aria-describedby={declarationError ? `${declarationId}-error` : undefined}
                onChange={(event) => {
                  setDeclared(event.target.checked);
                  if (event.target.checked) setDeclarationError(false);
                }}
                className={cn("mt-0.5 size-6 shrink-0 accent-[var(--garage-accent)]", focusRing)}
              />
              <label htmlFor={declarationId} className="text-[15px] leading-normal text-navy-950">{declaration}</label>
            </div>
            {declarationError ? (
              <p id={`${declarationId}-error`} role="alert" className="m-0 text-[14px] font-semibold text-[#991b1b]">
                Tick the declaration to confirm you hold these customers&apos; consent.
              </p>
            ) : null}
            <p className="m-0 text-[13px] text-grey-600">
              Reminders are only sent to customers with consent, never after they opt out, and only 09:00 to 19:00 Monday to Saturday.
              Customers who already opted out stay opted out.
            </p>
            <div className="flex flex-wrap gap-2.5">
              <button
                type="button"
                onClick={runImport}
                aria-disabled={importing || preview.validRows === 0 || undefined}
                disabled={preview.validRows === 0}
                className={buttonClass("primary")}
              >
                {importing ? <LoaderCircle size={18} strokeWidth={2} aria-hidden="true" className="animate-spin" /> : <Upload size={18} strokeWidth={2} aria-hidden="true" />}
                {importing ? "Importing…" : `Import ${preview.validRows.toLocaleString("en-GB")} ${preview.validRows === 1 ? "row" : "rows"}`}
              </button>
              <button type="button" onClick={reset} className={buttonClass("ghost")}>Start again</button>
            </div>
          </Panel>
        </>
      ) : null}
    </div>
  );
}
