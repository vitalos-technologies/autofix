import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, Download, FileSpreadsheet, Mail, Printer, Send } from "lucide-react";
import { z } from "zod";
import { Badge, buttonClass, DataTable, PageHeader, Panel, SubmitButton, textLinkClass, type DataTableColumn } from "@/components/admin-ui";
import { PlateChip } from "@/components/book/plate-chip";
import { ProLockedCard } from "@/components/plans";
import { getStatementDetail, type AccountInvoiceLine } from "@/lib/accounts/queries";
import { formatPounds, lineBalance, longDate, periodLabel, STATEMENT_STATUS_LABELS } from "@/lib/accounts/view";
import { garageHasFeature } from "@/lib/plans/server";
import { canManageSetup } from "@/lib/settings/setup";
import { getAdminContext } from "@/lib/tenancy/admin";
import { cn } from "@/lib/utils";
import { emailStatementAction, issueStatementAction, markStatementPaidAction } from "../../actions";
import { PrintButton } from "./print-button";

export const metadata: Metadata = { title: "Statement" };

const DONE: Record<string, string> = {
  generated: "Statement ready. Check it, then issue it.",
  issued: "Statement issued. Email it to the account next.",
  emailed: "Statement emailed.",
  paid: "Statement marked paid. Its invoices are paid too.",
};

const ERRORS: Record<string, string> = {
  not_allowed: "Only owners and managers of a garage on Pro can change statements.",
  not_saved: "That could not be saved. Try again.",
  nothing_to_bill: "There is nothing on this statement to issue.",
  already_issued: "This statement has already been issued.",
  not_issued: "Issue the statement before emailing it or marking it paid.",
  bad_payment: "Enter the date it was paid and how.",
  bad_recipient: "Enter a valid email address.",
  email_failed: "The email could not be sent. Try again in a minute.",
  email_not_configured: "Email isn't set up for this garage yet, so nothing was sent.",
  email_in_progress: "An invoice on this statement is being emailed. Try again in a minute.",
  plan_required: "Fleet and trade accounts are on Pro.",
};

const TONES = { draft: "muted", issued: "warning", paid: "success" } as const;

/** One account statement: its invoices, totals and the issue / email / paid actions, plus PDF, CSV and print. */
export default async function StatementPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string; error?: string }> }) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  const detail = await getStatementDetail(admin.client, admin.garage.id, id);
  if (!detail) notFound();
  const { statement, account, lines, totals } = detail;
  const query = await searchParams;
  const done = DONE[query.done ?? ""];
  const failed = ERRORS[query.error ?? ""];
  const enabled = garageHasFeature(admin.garage, "fleet_accounts");
  const canEdit = enabled && canManageSetup(admin.role);
  const today = new Date().toISOString().slice(0, 10);

  const columns: DataTableColumn<AccountInvoiceLine>[] = [
    { key: "invoice", header: "Invoice", rowHeader: true, cell: (line) => <Link href={`/app/invoices/${line.invoiceId}`} className={textLinkClass}>{line.invoiceNumber ?? "Draft"}</Link> },
    { key: "date", header: "Date", cell: (line) => (line.issueDate ? longDate(line.issueDate) : "") },
    { key: "car", header: "Car", cell: (line) => (line.registration ? <PlateChip registration={line.registration} /> : "") },
    { key: "driver", header: "Driver", cell: (line) => line.driver },
    { key: "po", header: "PO", cell: (line) => line.poNumber ?? "" },
    { key: "amount", header: "Amount", align: "right", cell: (line) => formatPounds(line.totalPence) },
    {
      key: "balance",
      header: "Balance",
      align: "right",
      cell: (line) => (line.status === "void" ? <Badge tone="muted" size="xs">Void</Badge> : lineBalance(line) === 0 ? <Badge tone="success" size="xs">Paid</Badge> : formatPounds(lineBalance(line))),
    },
  ];

  return (
    <div className="flex flex-col gap-5 pb-10">
      <Link href={`/app/accounts/${account.id}`} className={cn(textLinkClass, "-mb-2 gap-1.5 self-start text-[14px] print:hidden")}>
        <ArrowLeft size={18} strokeWidth={2} aria-hidden="true" /> {account.name}
      </Link>
      <PageHeader
        eyebrow={statement.reference}
        title={`Statement for ${periodLabel(statement.periodStart)}`}
        description={<span className="flex flex-wrap items-center gap-2"><span>{account.name}</span><Badge tone={TONES[statement.status]} size="xs">{STATEMENT_STATUS_LABELS[statement.status]}</Badge></span>}
        actions={
          <div className="flex flex-wrap gap-2.5 print:hidden">
            <a href={`/api/admin/accounts/statements/${statement.id}/pdf`} className={buttonClass("secondary")}>
              <Download size={17} strokeWidth={2} aria-hidden="true" /> PDF
            </a>
            <a href={`/api/admin/accounts/statements/${statement.id}/csv`} className={buttonClass("secondary")}>
              <FileSpreadsheet size={17} strokeWidth={2} aria-hidden="true" /> CSV
            </a>
            <PrintButton className={buttonClass("ghost")}>
              <Printer size={17} strokeWidth={2} aria-hidden="true" /> Print
            </PrintButton>
          </div>
        }
      />

      {done ? <div role="status" className="rounded-card border border-[#bfe5cb] bg-success-bg px-4 py-3.5 text-[14px] font-semibold text-success-ink print:hidden">{done}</div> : null}
      {failed ? <div role="alert" className="rounded-card border border-[#f3c4c4] bg-[#fdecec] px-4 py-3.5 text-[14px] font-semibold text-[#991b1b] print:hidden">{failed}</div> : null}
      {!enabled ? <div className="print:hidden"><ProLockedCard feature="fleet_accounts" canUpgrade={admin.role === "owner"} hasExistingData /></div> : null}

      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-5">
          <Panel title="Summary">
            <dl className="m-0 grid grid-cols-2 gap-3.5 sm:grid-cols-4">
              <div className="flex flex-col gap-0.5"><dt className="text-[12px] font-bold tracking-[0.06em] text-grey-600 uppercase">Period</dt><dd className="m-0 text-[15px] text-grey-800">{longDate(statement.periodStart)} to {longDate(statement.periodEnd)}</dd></div>
              <div className="flex flex-col gap-0.5"><dt className="text-[12px] font-bold tracking-[0.06em] text-grey-600 uppercase">Issued</dt><dd className="m-0 text-[15px] text-grey-800">{statement.issueDate ? longDate(statement.issueDate) : "Not yet"}</dd></div>
              <div className="flex flex-col gap-0.5"><dt className="text-[12px] font-bold tracking-[0.06em] text-grey-600 uppercase">Due by</dt><dd className="m-0 text-[15px] text-grey-800">{statement.dueDate ? longDate(statement.dueDate) : `${account.payment_terms_days} days after issue`}</dd></div>
              <div className="flex flex-col gap-0.5"><dt className="text-[12px] font-bold tracking-[0.06em] text-grey-600 uppercase">Balance due</dt><dd className="m-0 text-[20px] font-bold text-navy-950">{formatPounds(totals.balance)}</dd></div>
            </dl>
          </Panel>

          <Panel title="Invoices" count={lines.length} countLabel="invoices">
            <DataTable caption={`Invoices on statement ${statement.reference}`} columns={columns} rows={lines} getRowKey={(line) => line.invoiceId} minWidth={680} />
            <dl className="m-0 ml-auto flex w-full max-w-[320px] flex-col gap-1.5 text-[14px]">
              <div className="flex justify-between"><dt className="text-grey-700">Total</dt><dd className="m-0 font-semibold">{formatPounds(totals.total)}</dd></div>
              <div className="flex justify-between"><dt className="text-grey-700">Paid</dt><dd className="m-0 font-semibold">{formatPounds(totals.paid)}</dd></div>
              <div className="flex justify-between border-t-2 border-navy-950 pt-2 text-[17px] font-bold"><dt>Balance due</dt><dd className="m-0">{formatPounds(totals.balance)}</dd></div>
            </dl>
          </Panel>
        </div>

        <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-5 print:hidden">
          {canEdit && statement.status === "draft" ? (
            <Panel title="Issue">
              <p className="m-0 text-[14px] text-grey-700">Issuing adds any invoices issued since, sets today as the issue date and the due date {account.payment_terms_days} days later. The statement can&apos;t change after that.</p>
              <form action={issueStatementAction}>
                <input type="hidden" name="statementId" value={statement.id} />
                <SubmitButton className={buttonClass("primary", "md", "w-full")}>
                  <Send size={17} strokeWidth={2} aria-hidden="true" /> Issue statement
                </SubmitButton>
              </form>
            </Panel>
          ) : null}

          {canEdit && statement.status !== "draft" ? (
            <Panel id="email" title="Email">
              {statement.emailedAt ? (
                <p className="m-0 text-[14px] text-grey-700">
                  {statement.emailStatus === "failed" ? "The last email failed" : "Last emailed"} to {statement.emailedTo} on {longDate(statement.emailedAt.slice(0, 10))}.
                </p>
              ) : <p className="m-0 text-[14px] text-grey-700">Not emailed yet.</p>}
              <form action={emailStatementAction} className="flex flex-col gap-2">
                <input type="hidden" name="statementId" value={statement.id} />
                <label htmlFor="statement-recipient" className="text-[14px] font-semibold text-grey-800">Send to</label>
                <input id="statement-recipient" name="recipient" type="email" required defaultValue={account.billing_email ?? ""} autoComplete="email" className="h-11 rounded-input border border-grey-300 bg-white px-3 text-[15px] text-navy-950" />
                <SubmitButton className={buttonClass(statement.emailedAt ? "secondary" : "primary", "md")}>
                  <Mail size={17} strokeWidth={2} aria-hidden="true" /> {statement.emailedAt ? "Email again" : "Email statement"}
                </SubmitButton>
              </form>
            </Panel>
          ) : null}

          {canEdit && statement.status === "issued" ? (
            <Panel id="paid" title="Mark paid">
              <p className="m-0 text-[14px] text-grey-700">Records the balance of each unpaid invoice on the statement as paid.</p>
              <form action={markStatementPaidAction} className="flex flex-col gap-3">
                <input type="hidden" name="statementId" value={statement.id} />
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="paid-on" className="text-[14px] font-semibold text-grey-800">Paid on</label>
                  <input id="paid-on" name="paidOn" type="date" required defaultValue={today} className="h-11 rounded-input border border-grey-300 bg-white px-3 text-[15px] text-navy-950" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="paid-method" className="text-[14px] font-semibold text-grey-800">How</label>
                  <select id="paid-method" name="method" defaultValue="bank_transfer" className="h-11 rounded-input border border-grey-300 bg-white px-3 text-[15px] text-navy-950">
                    <option value="bank_transfer">Bank transfer</option>
                    <option value="card">Card</option>
                    <option value="cash">Cash</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="paid-reference" className="text-[14px] font-semibold text-grey-800">Reference (optional)</label>
                  <input id="paid-reference" name="reference" maxLength={120} className="h-11 rounded-input border border-grey-300 bg-white px-3 text-[15px] text-navy-950" />
                </div>
                <SubmitButton className={buttonClass("success", "md")}>Mark paid</SubmitButton>
              </form>
            </Panel>
          ) : null}

          {statement.status === "paid" ? (
            <Panel title="Paid">
              <p className="m-0 text-[14px] text-grey-700">
                Paid {statement.paidAt ? `on ${longDate(statement.paidAt.slice(0, 10))}` : ""}{statement.paymentMethod ? ` by ${statement.paymentMethod.replace("_", " ")}` : ""}{statement.paymentReference ? ` (${statement.paymentReference})` : ""}.
              </p>
            </Panel>
          ) : null}

          <Panel title="Bill to">
            <p className="m-0 text-[15px] font-bold text-navy-950">{account.name}</p>
            {account.billing_address ? <p className="m-0 text-[14px] whitespace-pre-line text-grey-800">{account.billing_address}</p> : null}
            <p className="m-0 text-[14px] text-grey-800">{account.billing_email ?? "No accounts email"}</p>
          </Panel>
        </div>
      </div>
    </div>
  );
}
