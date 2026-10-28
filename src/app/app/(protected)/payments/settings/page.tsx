import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, CircleCheck, CreditCard, Unplug } from "lucide-react";
import { Badge, buttonClass, DataTable, PageHeader, Panel, SubmitButton, textLinkClass, type DataTableColumn } from "@/components/admin-ui";
import { formatServicePrice } from "@/components/book";
import { ProLockedPage } from "@/components/plans";
import { PaymentSettingsForm } from "@/components/payments/settings-forms";
import { PAYMENTS_READINESS_MESSAGES } from "@/lib/payments";
import { connectPaymentsAction, disconnectPaymentsAction } from "@/lib/payments/admin-actions";
import { DEFAULT_HOLD_MIN, depositAmountPence, depositRuleLabel, formatPounds, type ServiceDepositMode } from "@/lib/payments/amounts";
import { loadPaymentsSetup } from "@/lib/payments/server";
import { getAdminContext } from "@/lib/tenancy/admin";
import { cn } from "@/lib/utils";
import { FlashMessage, ReadOnlyNotice, SetupNotice } from "../../settings/_components/setup-nav";

export const metadata: Metadata = { title: "Payment settings" };

const PATH = "/app/payments/settings";

const MESSAGES: Record<string, string> = {
  "done:connected": "Payments connected. Deposits and payment links can be used now.",
  "done:pending": "Your payment account isn't finished yet. Continue the setup to start taking payments.",
  "done:disconnected": "Payments disconnected. No deposits are taken and no new links can be sent.",
  "error:owner_only": "Only the garage owner can connect or disconnect payments.",
  "error:plan_required": "Payments are on Pro. Upgrade in Settings, Plan.",
  "error:unavailable": "Card payments aren't available on Autofix right now.",
  "error:provider": "The payment provider didn't respond. Try again in a few minutes.",
  "error:save_failed": "That could not be saved. Try again.",
};

type ServiceRow = { id: string; name: string; price_pence: number | null; price_mode: "fixed" | "from" | "quote"; deposit_mode: ServiceDepositMode; deposit_value: number | null };

/**
 * Payment settings (P5.4, Pro): connect the garage's own payment account (owners), deposits, the
 * hold and the no-show fee (owners and managers), and each service's deposit.
 */
export default async function PaymentSettingsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string; confirm?: string }> }) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  const { done, error, confirm } = await searchParams;
  const setup = await loadPaymentsSetup(admin.garage);
  const isOwner = admin.role === "owner";
  const canManage = isOwner || admin.role === "manager";
  const account = setup.account;
  const connected = account && account.status !== "disconnected";

  if (!setup.hasFeature) {
    return (
      <div className="flex flex-col gap-5 pb-10">
        <ProLockedPage feature="payments" title="Payment settings" canUpgrade={isOwner} hasExistingData={Boolean(account)} />
        {isOwner && connected ? (
          <Panel title="Payment account">
            <p className="m-0 text-[14px] text-grey-700">Your payment account is still connected. You can disconnect it.</p>
            <form action={disconnectPaymentsAction}>
              <input type="hidden" name="confirm" value="yes" />
              <SubmitButton className={buttonClass("secondary", "md")}>Disconnect payments</SubmitButton>
            </form>
          </Panel>
        ) : null}
      </div>
    );
  }

  const { data } = await admin.client
    .from("services")
    .select("id,name,price_pence,price_mode,deposit_mode,deposit_value")
    .eq("garage_id", admin.garage.id)
    .is("deleted_at", null)
    .order("sort", { ascending: true })
    .order("name", { ascending: true });
  const services = (data ?? []) as ServiceRow[];
  const settings = setup.settings;
  const depositSettings = settings ? { depositsEnabled: settings.deposits_enabled, defaultMode: settings.default_deposit_mode, defaultValue: settings.default_deposit_value } : null;
  const readinessMessage = setup.readiness === "mock" || setup.readiness === "stripe_test" ? null : PAYMENTS_READINESS_MESSAGES[setup.readiness];
  const accountForThisProvider = account && setup.provider && account.provider === setup.provider.kind;

  const columns: DataTableColumn<ServiceRow>[] = [
    { key: "name", header: "Service", rowHeader: true, cell: (row) => <span className="font-semibold text-navy-950">{row.name}</span> },
    { key: "price", header: "Price", cell: (row) => formatServicePrice(row.price_pence, row.price_mode) },
    { key: "rule", header: "Deposit", cell: (row) => depositRuleLabel(row.deposit_mode, row.deposit_value) },
    {
      key: "amount",
      header: "Customer pays",
      align: "right",
      cell: (row) => {
        const amount = depositAmountPence(depositSettings, { depositMode: row.deposit_mode, depositValue: row.deposit_value, pricePence: row.price_pence, priceMode: row.price_mode });
        return amount === null ? <span className="text-grey-600">Nothing</span> : <span className="font-semibold text-navy-950">{formatPounds(amount)}</span>;
      },
    },
    {
      key: "edit",
      header: <span className="sr-only">Change</span>,
      cell: (row) => (
        <Link href={`/app/settings/services/${row.id}#deposit`} className={cn(textLinkClass, "min-h-11 text-[14px]")}>
          Change<span className="sr-only"> the deposit for {row.name}</span>
        </Link>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-5 pb-10">
      <Link href="/app/payments" className={`${textLinkClass} w-fit gap-1.5 text-[14px]`}>
        <ArrowLeft size={18} strokeWidth={2} aria-hidden="true" />
        Payments
      </Link>
      <PageHeader eyebrow="Payments" title="Payment settings" description="Take deposits at booking, send invoices to pay by link and charge no-show fees." />
      <FlashMessage messages={MESSAGES} done={done} error={error} />
      {readinessMessage ? <SetupNotice tone="warning">{readinessMessage}</SetupNotice> : null}
      {!admin.mfaVerified && canManage ? (
        <SetupNotice tone="warning">
          To change these settings, verify your sign-in first.{" "}
          <Link href={`/app/mfa?returnTo=${encodeURIComponent(PATH)}&stepUp=1`} className="underline">Verify now</Link>
        </SetupNotice>
      ) : null}

      <div className="flex flex-wrap items-start gap-[18px]">
        <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-[18px]">
          <Panel id="account" title="Payment account">
            {connected ? (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  {account.status === "active" ? (
                    <Badge tone="success"><span className="inline-flex items-center gap-1"><CircleCheck size={13} strokeWidth={2.4} aria-hidden="true" />Connected</span></Badge>
                  ) : (
                    <Badge tone="warning">{account.status === "restricted" ? "Needs more details" : "Setup not finished"}</Badge>
                  )}
                  <span className="text-[14px] text-grey-700">{account.provider === "stripe" ? "Stripe (test mode)" : "Test payments (no money moves)"}</span>
                </div>
                <p className="m-0 text-[14px] text-grey-700">
                  Customers pay {admin.garage.name} directly. Autofix takes no fee on these payments.
                </p>
              </div>
            ) : (
              <p className="m-0 text-[14px] text-grey-700">
                Connect a payment account so customers can pay {admin.garage.name} by card: deposits at booking, invoices and no-show fees.
              </p>
            )}
            {isOwner ? (
              <div className="flex flex-wrap gap-2.5">
                {setup.provider && (!connected || account.status !== "active" || !accountForThisProvider) ? (
                  <form action={connectPaymentsAction}>
                    <SubmitButton className={buttonClass("primary", "md")} disabled={!admin.mfaVerified}>
                      <CreditCard size={17} strokeWidth={2} aria-hidden="true" />
                      {connected && accountForThisProvider ? "Continue setup" : "Connect payments"}
                    </SubmitButton>
                  </form>
                ) : null}
                {connected ? (
                  confirm === "disconnect" ? (
                    <form action={disconnectPaymentsAction} className="flex w-full flex-col gap-2.5 rounded-input border border-grey-200 bg-grey-50 p-3">
                      <p className="m-0 text-[14px] text-navy-950">Disconnect payments? No deposits are taken and no new links can be sent until you connect again. Links already sent stop working.</p>
                      <input type="hidden" name="confirm" value="yes" />
                      <div className="flex flex-wrap gap-2">
                        <SubmitButton className={buttonClass("secondary", "md")} disabled={!admin.mfaVerified}>Yes, disconnect</SubmitButton>
                        <Link href={PATH} className={buttonClass("ghost", "md")}>Keep connected</Link>
                      </div>
                    </form>
                  ) : (
                    <form action={disconnectPaymentsAction}>
                      <SubmitButton className={buttonClass("ghost", "md")} disabled={!admin.mfaVerified}>
                        <Unplug size={17} strokeWidth={2} aria-hidden="true" />
                        Disconnect
                      </SubmitButton>
                    </form>
                  )
                ) : null}
              </div>
            ) : (
              <p className="m-0 text-[13px] text-grey-600">Only the garage owner can connect or disconnect payments.</p>
            )}
          </Panel>

          <Panel id="deposits" title="Deposits and fees">
            {!canManage ? <ReadOnlyNotice level="manage" /> : null}
            <PaymentSettingsForm
              disabled={!canManage || !admin.mfaVerified}
              values={{
                depositsEnabled: settings?.deposits_enabled ?? false,
                defaultMode: settings?.default_deposit_mode ?? "none",
                defaultValue: settings?.default_deposit_value ?? null,
                holdMin: settings?.deposit_hold_min ?? DEFAULT_HOLD_MIN,
                noShowFeePence: settings?.no_show_fee_pence ?? null,
                anyServiceDeposit: services.some((service) => service.deposit_mode === "fixed" || service.deposit_mode === "percent"),
              }}
            />
          </Panel>
        </div>

        <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-[18px]">
          <Panel id="how" title="How deposits work">
            <ol className="m-0 flex list-decimal flex-col gap-2 pl-5 text-[14px] leading-normal text-grey-700">
              <li>The customer books online as usual; the time is held for them straight away.</li>
              <li>They pay the deposit on your booking page. Their confirmation is sent once it is paid.</li>
              <li>If it isn&apos;t paid in time, the booking is cancelled (&ldquo;Deposit not paid in time&rdquo;) and the time is free again.</li>
            </ol>
            <p className="m-0 text-[13px] text-grey-600">Phone and walk-in bookings you make yourself never ask for a deposit.</p>
          </Panel>
        </div>
      </div>

      <Panel id="services" title="Deposits by service" padding="flush">
        <DataTable caption="Deposit for each service" columns={columns} rows={services} getRowKey={(row) => row.id} minWidth={620} />
      </Panel>
    </div>
  );
}
