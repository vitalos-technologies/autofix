import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Building2, ChevronRight, Plus } from "lucide-react";
import { Badge, buttonClass, EmptyState, PageHeader, Panel } from "@/components/admin-ui";
import { ProLockedCard } from "@/components/plans";
import { AccountDataError, listAccounts, type AccountSummary } from "@/lib/accounts/queries";
import { ACCOUNT_KIND_LABELS, BILLING_LABELS, creditPosition, formatPounds } from "@/lib/accounts/view";
import { garageHasFeature } from "@/lib/plans/server";
import { canManageSetup } from "@/lib/settings/setup";
import { getAdminContext } from "@/lib/tenancy/admin";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Fleet and trade accounts" };

function AccountCard({ account }: { account: AccountSummary }) {
  const credit = creditPosition(account.creditLimitPence, account.owedPence);
  return (
    <li>
      <Link
        href={`/app/accounts/${account.id}`}
        className={cn(
          "flex min-h-11 items-center gap-3 rounded-card border border-grey-200 bg-white p-4 text-navy-950 no-underline hover:border-grey-600",
          "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-accent",
          account.archived && "bg-grey-50",
        )}
      >
        <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-full bg-grey-100 text-grey-700">
          <Building2 size={20} strokeWidth={2} />
        </span>
        <span className="flex min-w-0 grow flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[16px] font-bold">{account.name}</span>
            <Badge tone="navy" size="xs">{ACCOUNT_KIND_LABELS[account.kind]}</Badge>
            {account.archived ? <Badge tone="muted" size="xs">Archived</Badge> : null}
          </span>
          <span className="text-[14px] text-grey-700">
            {account.vehicleCount === 1 ? "1 car" : `${account.vehicleCount} cars`} · {BILLING_LABELS[account.billing]}
            {account.unbilledCount ? ` · ${account.unbilledCount} not on a statement` : ""}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1 text-right">
          <span className="text-[15px] font-bold">{formatPounds(account.owedPence)}</span>
          <span className={cn("text-[12.5px]", credit?.over ? "font-bold text-[#991b1b]" : "text-grey-600")}>
            {credit ? (credit.over ? "Over credit limit" : `owed of ${formatPounds(account.creditLimitPence)}`) : "owed"}
          </span>
        </span>
        <ChevronRight size={18} strokeWidth={2} aria-hidden="true" className="shrink-0 text-grey-600" />
      </Link>
    </li>
  );
}

/**
 * Fleet and trade accounts (P5.7, Pro). Every member reads the list; owners and managers add and
 * change accounts. On Essentials the page shows the Pro card, and accounts made while on Pro stay
 * listed read-only underneath.
 */
export default async function AccountsPage() {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  const enabled = garageHasFeature(admin.garage, "fleet_accounts");
  const canManage = canManageSetup(admin.role);

  let accounts: AccountSummary[] = [];
  let loadFailed = false;
  try {
    accounts = await listAccounts(admin.client, admin.garage.id);
  } catch (error) {
    if (!(error instanceof AccountDataError)) throw error;
    loadFailed = true;
  }
  const active = accounts.filter((account) => !account.archived);
  const archived = accounts.filter((account) => account.archived);
  const owed = active.reduce((sum, account) => sum + account.owedPence, 0);

  return (
    <div className="flex flex-col gap-5 pb-10">
      <PageHeader
        eyebrow="Customers"
        title="Fleet and trade accounts"
        description="Businesses with several cars, billed on one monthly statement."
        actions={enabled && canManage ? (
          <Link href="/app/accounts/new" className={buttonClass("primary")}>
            <Plus size={18} strokeWidth={2.2} aria-hidden="true" /> New account
          </Link>
        ) : null}
      />

      {!enabled ? <ProLockedCard feature="fleet_accounts" canUpgrade={admin.role === "owner"} hasExistingData={accounts.length > 0} /> : null}

      {loadFailed ? (
        <div role="alert" className="rounded-card border border-[#f3c4c4] bg-[#fdecec] px-4 py-3.5 text-[14px] font-semibold text-[#991b1b]">
          Accounts could not be loaded. Refresh the page to try again.
        </div>
      ) : null}

      {!loadFailed && active.length === 0 && enabled ? (
        <EmptyState
          tone="card"
          icon={Building2}
          headingLevel={2}
          title="No business accounts yet"
          description="Add a fleet or trade customer, put their cars on it and book them in against the account. Their invoices go on one statement a month."
          action={canManage ? (
            <Link href="/app/accounts/new" className={buttonClass("primary")}>
              <Plus size={18} strokeWidth={2.2} aria-hidden="true" /> New account
            </Link>
          ) : null}
        />
      ) : null}

      {active.length > 0 ? (
        <Panel title="Accounts" count={active.length} countLabel="accounts" actions={<span className="text-[14px] text-grey-700">{formatPounds(owed)} owed in all</span>}>
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
            {active.map((account) => <AccountCard key={account.id} account={account} />)}
          </ul>
        </Panel>
      ) : null}

      {archived.length > 0 ? (
        <Panel title="Archived" count={archived.length} countLabel="archived accounts">
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
            {archived.map((account) => <AccountCard key={account.id} account={account} />)}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}
