import Link from "next/link";
import { CreditCard } from "lucide-react";
import { buttonClass, Panel, SubmitButton, textLinkClass } from "@/components/admin-ui";
import { formatSlotLabel } from "@/components/book/format";
import { ProBadge } from "@/components/plans";
import { SetupNotice } from "@/app/app/(protected)/settings/_components/setup-nav";
import { cancelPaymentAction, chargeNoShowFeeAction, sendInvoicePaymentLinkAction } from "@/lib/payments/admin-actions";
import { formatPounds } from "@/lib/payments/amounts";
import { loadPaymentsSetup, PAYMENT_COLUMNS, type PaymentRow } from "@/lib/payments/server";
import type { AdminContext } from "@/lib/tenancy/admin";
import { cn } from "@/lib/utils";
import { attentionLabel, PAYMENT_FLASH, PaymentStatusBadge, paymentKindLabel } from "./status";
import { ServiceDepositForm } from "./settings-forms";

// Payment panels added to existing admin pages (P5.4): a booking's deposit and no-show fee, an
// invoice's pay links, a service's deposit. Server components; reads go through the member's RLS
// client (members read payments), writes through ./admin-actions.

type Admin = Pick<AdminContext, "client" | "garage" | "role" | "user">;

const LINK_ROLES = new Set(["owner", "manager", "front_desk"]);

function Flash({ code }: { code?: string }) {
  const flash = code ? PAYMENT_FLASH[code] : undefined;
  return flash ? <SetupNotice tone={flash.tone}>{flash.text}</SetupNotice> : null;
}

function notifiedLine(row: PaymentRow, timeZone: string): string | null {
  if (!row.notified_at) return null;
  const when = formatSlotLabel(row.notified_at, timeZone);
  if (row.notify_channel === "none") return `Not sent (${row.notify_outcome === "opted_out" ? "opted out of texts, no email" : "no contact details"}), ${when}`;
  const by = row.notify_channel === "email" ? "email" : row.notify_channel === "whatsapp" ? "WhatsApp" : "text";
  return row.notify_outcome === "sent" ? `Sent by ${by}, ${when}` : `Sending by ${by} failed, ${when}`;
}

function PaymentList({ rows, timeZone, canAct, returnTo }: { rows: PaymentRow[]; timeZone: string; canAct: boolean; returnTo: string }) {
  return (
    <ul className="m-0 flex list-none flex-col p-0" aria-label="Payments">
      {rows.map((row) => {
        const attention = attentionLabel(row.attention);
        const sent = notifiedLine(row, timeZone);
        return (
          <li key={row.id} className="flex flex-col gap-1.5 border-t border-[#f1f5f9] py-3 first:border-t-0 first:pt-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[15px] font-bold text-navy-950">
                {paymentKindLabel(row.kind)} · {formatPounds(row.status === "paid" ? (row.amount_paid_pence ?? row.amount_pence) : row.amount_pence)}
              </span>
              <PaymentStatusBadge status={row.status} attention={row.attention} />
            </div>
            <p className="m-0 text-[13px] text-grey-600">
              {row.status === "paid" && row.paid_at
                ? `Paid ${formatSlotLabel(row.paid_at, timeZone)}`
                : row.status === "pending"
                  ? `${row.kind === "deposit" ? "Time held" : "Link works"} until ${formatSlotLabel(row.expires_at, timeZone)}`
                  : (row.cancelled_reason ?? `Made ${formatSlotLabel(row.created_at, timeZone)}`)}
            </p>
            {sent ? <p className="m-0 text-[13px] text-grey-600">{sent}</p> : null}
            {attention ? <p className="m-0 text-[13px] font-semibold text-[#991b1b]">{attention}</p> : null}
            {canAct && row.status === "pending" ? (
              <form action={cancelPaymentAction}>
                <input type="hidden" name="paymentId" value={row.id} />
                <input type="hidden" name="returnTo" value={returnTo} />
                <SubmitButton className={buttonClass("ghost", "sm")}>{row.kind === "deposit" ? "Waive the deposit" : "Cancel the link"}</SubmitButton>
              </form>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Booking page: its deposit and no-show fee, and "Charge no-show fee" for a no-show. */
export async function BookingPaymentsPanel({ admin, bookingId, status, flash }: { admin: Admin; bookingId: string; status: string; flash?: string }) {
  const [{ data }, setup] = await Promise.all([
    admin.client.from("payments").select(PAYMENT_COLUMNS).eq("garage_id", admin.garage.id).eq("booking_id", bookingId).order("created_at", { ascending: false }),
    loadPaymentsSetup(admin.garage),
  ]);
  const rows = (data ?? []) as PaymentRow[];
  if (!setup.hasFeature && rows.length === 0) return null;
  const canAct = setup.hasFeature && LINK_ROLES.has(admin.role);
  const liveFee = rows.find((row) => row.kind === "no_show_fee" && (row.status === "pending" || row.status === "paid"));
  const fee = setup.settings?.no_show_fee_pence ?? null;
  const timeZone = admin.garage.timezone || "Europe/London";

  return (
    <Panel id="payments" title={<span className="inline-flex items-center gap-2">Payments{setup.hasFeature ? null : <ProBadge />}</span>}>
      <Flash code={flash} />
      {rows.length ? <PaymentList rows={rows} timeZone={timeZone} canAct={canAct} returnTo={`/app/bookings/${bookingId}`} /> : (
        <p className="m-0 text-[14px] text-grey-600">No deposit or fee on this booking.</p>
      )}
      {status === "no_show" && canAct && liveFee?.status !== "paid" ? (
        fee && setup.active ? (
          <form action={chargeNoShowFeeAction} className="flex flex-col gap-2 border-t border-[#f1f5f9] pt-3.5">
            <input type="hidden" name="bookingId" value={bookingId} />
            <SubmitButton className={buttonClass(liveFee ? "secondary" : "primary", "md", "w-full sm:w-fit")}>
              <CreditCard size={17} strokeWidth={2} aria-hidden="true" />
              {liveFee ? "Send the fee link again" : `Charge no-show fee (${formatPounds(fee)})`}
            </SubmitButton>
            <p className="m-0 text-[13px] text-grey-600">The customer gets a payment link by text, WhatsApp or email.</p>
          </form>
        ) : (
          <p className="m-0 border-t border-[#f1f5f9] pt-3.5 text-[14px] text-grey-700">
            {setup.active ? "Set a no-show fee to charge one by link. " : "Connect a payment account to charge a no-show fee. "}
            <Link href="/app/payments/settings" className={textLinkClass}>Payment settings</Link>
          </p>
        )
      ) : null}
      {!setup.hasFeature ? <p className="m-0 text-[13px] text-grey-600">Payments are on Pro: you can see them, not change them.</p> : null}
    </Panel>
  );
}

/** Invoice page: "Send payment link" for an issued invoice, and the links sent so far. */
export async function InvoicePaymentLinkPanel({ admin, invoiceId, invoiceStatus, balancePence, flash }: { admin: Admin; invoiceId: string; invoiceStatus: string; balancePence: number; flash?: string }) {
  const [{ data }, setup] = await Promise.all([
    admin.client.from("payments").select(PAYMENT_COLUMNS).eq("garage_id", admin.garage.id).eq("invoice_id", invoiceId).order("created_at", { ascending: false }).limit(10),
    loadPaymentsSetup(admin.garage),
  ]);
  const rows = (data ?? []) as PaymentRow[];
  if (invoiceStatus !== "issued" && rows.length === 0) return null;
  const canAct = setup.hasFeature && LINK_ROLES.has(admin.role);
  const timeZone = admin.garage.timezone || "Europe/London";
  const pending = rows.find((row) => row.status === "pending");

  return (
    <section id="payments" className="scroll-mt-20 rounded-2xl border border-[#E2E8F0] bg-white p-5">
      <h2 className="flex items-center gap-2 text-lg font-extrabold text-[#0f2747]">
        <CreditCard size={18} aria-hidden="true" /> Pay by link {setup.hasFeature ? null : <ProBadge />}
      </h2>
      <div className="mt-3 flex flex-col gap-3">
        <Flash code={flash} />
        {invoiceStatus === "issued" ? (
          !setup.hasFeature ? (
            <p className="m-0 text-sm text-grey-600">
              Customers pay by card from a link. <Link href="/app/settings/plan#compare" className={textLinkClass}>See Pro</Link>
            </p>
          ) : !setup.active ? (
            <p className="m-0 text-sm text-grey-600">
              Connect a payment account to send payment links. <Link href="/app/payments/settings" className={textLinkClass}>Payment settings</Link>
            </p>
          ) : canAct && balancePence >= 100 ? (
            <form action={sendInvoicePaymentLinkAction} className="flex flex-col gap-2">
              <input type="hidden" name="invoiceId" value={invoiceId} />
              <SubmitButton className={cn(buttonClass("primary", "md"), "w-full justify-center")}>
                {pending ? "Send a new payment link" : `Send payment link (${formatPounds(balancePence)})`}
              </SubmitButton>
              <p className="m-0 text-xs text-grey-600">For the balance due. Sent by the customer&apos;s text, WhatsApp or email; a new link replaces the old one.</p>
            </form>
          ) : null
        ) : null}
        {rows.length ? <PaymentList rows={rows} timeZone={timeZone} canAct={canAct} returnTo={`/app/invoices/${invoiceId}`} /> : null}
      </div>
    </section>
  );
}

/** Service edit page: the service's deposit (owners and managers, Pro). */
export async function ServiceDepositPanel({ admin, serviceId }: { admin: Admin; serviceId: string }) {
  const [{ data }, setup] = await Promise.all([
    admin.client.from("services").select("deposit_mode,deposit_value").eq("garage_id", admin.garage.id).eq("id", serviceId).maybeSingle(),
    loadPaymentsSetup(admin.garage),
  ]);
  const row = data as { deposit_mode: "default" | "none" | "fixed" | "percent"; deposit_value: number | null } | null;
  if (!row) return null;
  const canEdit = setup.hasFeature && (admin.role === "owner" || admin.role === "manager");
  return (
    <Panel id="deposit" title={<span className="inline-flex items-center gap-2">Deposit{setup.hasFeature ? null : <ProBadge />}</span>}>
      {!setup.hasFeature ? (
        <p className="m-0 text-[14px] text-grey-700">
          Deposits at booking are on Pro. <Link href="/app/settings/plan#compare" className={textLinkClass}>See Pro</Link>
        </p>
      ) : (
        <>
          {!setup.settings?.deposits_enabled ? (
            <SetupNotice>
              Deposits are off for online bookings. <Link href="/app/payments/settings" className="underline">Turn them on</Link> in Payment settings.
            </SetupNotice>
          ) : null}
          <ServiceDepositForm serviceId={serviceId} mode={row.deposit_mode} value={row.deposit_value} disabled={!canEdit} />
        </>
      )}
    </Panel>
  );
}
