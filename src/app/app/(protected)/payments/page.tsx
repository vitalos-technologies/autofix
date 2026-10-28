import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CreditCard, Settings } from "lucide-react";
import { buttonClass, DataTable, EmptyState, KpiCard, KpiGrid, PageHeader, Panel, SubmitButton, textLinkClass, type DataTableColumn } from "@/components/admin-ui";
import { formatSlotLabel } from "@/components/book/format";
import { ProLockedPage } from "@/components/plans";
import { attentionLabel, PAYMENT_FLASH, PaymentStatusBadge, paymentKindLabel } from "@/components/payments/status";
import { localDateKey, monthStart, startOfLocalDay } from "@/lib/admin/dates";
import { PAYMENTS_READINESS_MESSAGES } from "@/lib/payments";
import { cancelPaymentAction } from "@/lib/payments/admin-actions";
import { formatPounds, isPaymentKind, paymentTotals, PAYMENT_KIND_LABELS, type PaymentKind } from "@/lib/payments/amounts";
import { loadPaymentsSetup, PAYMENT_COLUMNS, releaseExpiredDeposits, type PaymentRow } from "@/lib/payments/server";
import { getAdminContext } from "@/lib/tenancy/admin";
import { cn } from "@/lib/utils";
import { SetupNotice } from "../settings/_components/setup-nav";

export const metadata: Metadata = { title: "Payments" };

type PageProps = { searchParams: Promise<{ kind?: string; payments?: string }> };

const FILTERS: { key: PaymentKind | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "deposit", label: "Deposits" },
  { key: "invoice", label: "Invoices" },
  { key: "no_show_fee", label: "No-show fees" },
];

const LINK_ROLES = new Set(["owner", "manager", "front_desk"]);

function whereLink(row: PaymentRow) {
  if (row.invoice_id) return { href: `/app/invoices/${row.invoice_id}`, label: "Open invoice" };
  if (row.booking_id) return { href: `/app/bookings/${row.booking_id}`, label: "Open booking" };
  return null;
}

/**
 * Payments (P5.4, Pro): every deposit, invoice payment link and no-show fee, with this month's
 * totals. Reads go through the member's RLS client; expired deposits are released first so the list
 * and the diary agree.
 */
export default async function PaymentsPage({ searchParams }: PageProps) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  const { kind: rawKind, payments: flashCode } = await searchParams;
  const kind = isPaymentKind(rawKind) ? rawKind : null;
  const timeZone = admin.garage.timezone || "Europe/London";

  const setup = await loadPaymentsSetup(admin.garage);
  if (setup.hasFeature) await releaseExpiredDeposits(admin.garage.id);
  let query = admin.client.from("payments").select(PAYMENT_COLUMNS).eq("garage_id", admin.garage.id).order("created_at", { ascending: false }).limit(300);
  if (kind) query = query.eq("kind", kind);
  const { data, error } = await query;
  const rows = (data ?? []) as PaymentRow[];

  if (!setup.hasFeature) {
    return (
      <div className="flex flex-col gap-5 pb-10">
        <ProLockedPage feature="payments" title="Payments" canUpgrade={admin.role === "owner"} hasExistingData={rows.length > 0} />
        {rows.length ? <PaymentsTable rows={rows} timeZone={timeZone} canAct={false} /> : null}
      </div>
    );
  }

  const now = new Date();
  const totals = paymentTotals(
    rows.map((row) => ({ status: row.status, kind: row.kind, amountPence: row.amount_pence, amountPaidPence: row.amount_paid_pence, paidAt: row.paid_at, attention: row.attention })),
    startOfLocalDay(monthStart(localDateKey(now, timeZone)), timeZone),
  );
  const flash = flashCode ? PAYMENT_FLASH[flashCode] : undefined;
  const readinessMessage = setup.readiness === "mock" || setup.readiness === "stripe_test" ? null : PAYMENTS_READINESS_MESSAGES[setup.readiness];

  return (
    <div className="flex flex-col gap-5 pb-10">
      <PageHeader
        eyebrow="Grow"
        title="Payments"
        description="Deposits taken at booking, invoices paid by link and no-show fees."
        actions={
          <Link href="/app/payments/settings" className={buttonClass("secondary", "md")}>
            <Settings size={17} strokeWidth={2} aria-hidden="true" />
            Payment settings
          </Link>
        }
      />
      {flash ? <SetupNotice tone={flash.tone}>{flash.text}</SetupNotice> : null}
      {readinessMessage ? <SetupNotice tone="warning">{readinessMessage}</SetupNotice> : null}
      {!setup.active && !readinessMessage ? (
        <SetupNotice tone="warning">
          No payment account is connected, so no deposits are taken and no links can be sent.{" "}
          <Link href="/app/payments/settings" className="font-semibold underline">Connect one in Payment settings</Link>
        </SetupNotice>
      ) : null}
      {setup.readiness === "mock" && setup.active ? (
        <SetupNotice>Test mode: payments are simulated and no money moves.</SetupNotice>
      ) : null}
      {error ? <SetupNotice tone="danger">Payments could not be loaded. Refresh the page to try again.</SetupNotice> : null}

      <KpiGrid>
        <KpiCard size="sm" label="Paid this month" value={formatPounds(totals.paidThisMonthPence)} context={`${totals.paidThisMonthCount} ${totals.paidThisMonthCount === 1 ? "payment" : "payments"}`} />
        <KpiCard size="sm" label="Waiting to be paid" value={formatPounds(totals.waitingPence)} context={`${totals.waitingCount} open`} />
        <KpiCard size="sm" label="Deposits paid" value={formatPounds(totals.depositsHeldPence)} context="Come off the customer's bill" />
        <KpiCard size="sm" label="Need a look" value={String(totals.attentionCount)} context={totals.attentionCount ? "Refund or rebook" : "Nothing to do"} />
      </KpiGrid>

      <nav aria-label="Filter payments" className="-mx-1 overflow-x-auto px-1 py-1">
        <ul className="m-0 flex w-max list-none gap-1 rounded-control border border-grey-200 bg-white p-1">
          {FILTERS.map((filter) => {
            const active = (filter.key === "all" && !kind) || filter.key === kind;
            return (
              <li key={filter.key}>
                <Link
                  href={filter.key === "all" ? "/app/payments" : `/app/payments?kind=${filter.key}`}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-11 items-center rounded-[10px] px-3.5 text-[14px] font-semibold whitespace-nowrap no-underline",
                    active ? "bg-navy-950 text-white" : "text-grey-700 hover:bg-grey-100 hover:text-navy-950",
                  )}
                >
                  {filter.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <PaymentsTable rows={rows} timeZone={timeZone} canAct={LINK_ROLES.has(admin.role)} kind={kind} />
    </div>
  );
}

function PaymentsTable({ rows, timeZone, canAct, kind = null }: { rows: PaymentRow[]; timeZone: string; canAct: boolean; kind?: PaymentKind | null }) {
  const columns: DataTableColumn<PaymentRow>[] = [
    {
      key: "what",
      header: "Payment",
      rowHeader: true,
      cell: (row) => {
        const attention = attentionLabel(row.attention);
        return (
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-semibold text-navy-950">{row.description}</span>
            <span className="text-[13px] text-grey-600">{paymentKindLabel(row.kind)} · {formatSlotLabel(row.paid_at ?? row.created_at, timeZone)}</span>
            {attention ? <span className="text-[13px] font-semibold text-[#991b1b]">{attention}</span> : null}
          </div>
        );
      },
    },
    { key: "amount", header: "Amount", align: "right", cell: (row) => <span className="font-semibold text-navy-950">{formatPounds(row.status === "paid" ? (row.amount_paid_pence ?? row.amount_pence) : row.amount_pence)}</span> },
    { key: "status", header: "Status", cell: (row) => <PaymentStatusBadge status={row.status} attention={row.attention} /> },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      cell: (row) => {
        const where = whereLink(row);
        return (
          <div className="flex flex-wrap items-center gap-2">
            {where ? <Link href={where.href} className={cn(textLinkClass, "min-h-11 text-[14px]")}>{where.label}</Link> : null}
            {canAct && row.status === "pending" ? (
              <form action={cancelPaymentAction}>
                <input type="hidden" name="paymentId" value={row.id} />
                <input type="hidden" name="returnTo" value="/app/payments" />
                <SubmitButton className={buttonClass("ghost", "sm")}>{row.kind === "deposit" ? "Waive" : "Cancel link"}</SubmitButton>
              </form>
            ) : null}
          </div>
        );
      },
    },
  ];
  return (
    <Panel title={kind ? PAYMENT_KIND_LABELS[kind] : "All payments"} padding="flush">
      <DataTable
        caption="Payments, newest first"
        columns={columns}
        rows={rows}
        getRowKey={(row) => row.id}
        minWidth={640}
        empty={<EmptyState icon={CreditCard} title="No payments yet" description="Deposits, invoice payments and no-show fees show here as customers pay." />}
      />
    </Panel>
  );
}
