import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle, CheckCircle2, Clock3, RefreshCw } from "lucide-react";
import { Badge, buttonClass, PageHeader, Panel, SubmitButton } from "@/components/admin-ui";
import { Notice } from "@/components/onboarding/field";
import { ProLockedPage } from "@/components/plans";
import { hasAccountingKey } from "@/lib/accounting/crypto";
import { accountingMode, getAccountingProvider } from "@/lib/accounting/providers";
import { listConnectionTenants, loadAccountingOverview, type ConnectionView, type SyncItemView } from "@/lib/accounting/server";
import { ACCOUNTING_PROVIDER_NAMES, REAL_ACCOUNTING_PROVIDERS, type AccountingProviderId } from "@/lib/accounting/types";
import { garageHasFeature } from "@/lib/plans/server";
import { getAdminContext } from "@/lib/tenancy/admin";
import { chooseOrganisationAction, disconnectAction, retryItemAction, syncNowAction } from "./actions";

export const metadata: Metadata = { title: "Accounting" };

const PATH = "/app/settings/accounting";

const FLASH: Record<string, { tone: "success" | "error" | "info"; text: string }> = {
  connected: { tone: "success", text: "Connected. New invoices and payments will sync from now on." },
  disconnected: { tone: "success", text: "Disconnected. We deleted the stored sign-in; your sync history stays here." },
  sync_started: { tone: "info", text: "Syncing now. Reload in a minute to see the result." },
  retry_started: { tone: "info", text: "Trying that one again now." },
  owner_only: { tone: "error", text: "Only the garage owner can connect or disconnect accounting." },
  not_allowed: { tone: "error", text: "Only owners and managers can sync." },
  plan: { tone: "error", text: "Accounting sync is on Pro." },
  configuration_required: { tone: "error", text: "That provider isn't set up on Autofix yet. Vitalos has been told; try again later." },
  connect_denied: { tone: "info", text: "You cancelled the connection. Nothing has changed." },
  connect_expired: { tone: "error", text: "That took too long. Start the connection again." },
  connect_state: { tone: "error", text: "We couldn't match that sign-in to this page. Start the connection again." },
  connect_failed: { tone: "error", text: "The connection didn't work. Try again." },
  no_organisation: { tone: "error", text: "That account has no organisation we can use." },
  choose_one: { tone: "error", text: "Choose an organisation." },
  choose_failed: { tone: "error", text: "That organisation couldn't be chosen. Try again." },
  not_connected: { tone: "error", text: "Connect an accounting system first." },
  sync_failed: { tone: "error", text: "The sync couldn't start. Try again." },
  retry_failed: { tone: "error", text: "That item couldn't be retried. Reload and try again." },
  disconnect_failed: { tone: "error", text: "The connection couldn't be ended. Try again." },
  read_only: { tone: "error", text: "Support sessions are read only." },
};

const PROVIDER_BLURB: Record<Exclude<AccountingProviderId, "fake">, string> = {
  xero: "Invoices, payments and contacts go to your Xero organisation.",
  quickbooks: "Invoices, payments and customers go to your QuickBooks Online company.",
  sage: "Invoices, receipts and contacts go to your Sage Accounting business.",
};

/** Plain-English reasons for the stored error codes (never the provider's own text). */
const ERROR_TEXT: Record<string, string> = {
  VALIDATION: "Refused: check the account codes, tax settings and customer in your accounts",
  NOT_FOUND: "Not found in your accounts",
  RATE_LIMITED: "Waiting: your accounts asked us to slow down",
  AUTH_EXPIRED: "Reconnect needed",
  PROVIDER_UNAVAILABLE: "Your accounting system was unavailable",
  NETWORK: "Couldn't reach your accounting system",
  UNEXPECTED_RESPONSE: "Unexpected answer from your accounting system",
  CONFIGURATION_REQUIRED: "Provider not set up on Autofix yet",
  INVOICE_NOT_SYNCED: "Its invoice didn't sync",
  INVOICE_VOID: "Invoice was voided, so it wasn't sent",
  INVOICE_NOT_ISSUED: "Invoice isn't issued",
  LOCAL_NOT_FOUND: "No longer in Autofix",
  DISCONNECTED: "Not sent before you disconnected",
  UNEXPECTED: "Something went wrong",
};

function formatWhen(iso: string | null, timeZone: string) {
  if (!iso) return "Not yet";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(iso));
}

function statusBadge(connection: ConnectionView) {
  if (connection.status === "connected") return <Badge tone="success">Connected</Badge>;
  if (connection.status === "needs_reconnect") return <Badge tone="warning">Reconnect needed</Badge>;
  return <Badge tone="info">Choose organisation</Badge>;
}

function ItemRow({ item, timeZone, canRetry }: { item: SyncItemView; timeZone: string; canRetry: boolean }) {
  const icon = item.status === "synced"
    ? <CheckCircle2 size={18} className="shrink-0 text-success-ink" aria-hidden="true" />
    : item.status === "failed"
      ? <AlertTriangle size={18} className="shrink-0 text-[#991b1b]" aria-hidden="true" />
      : <Clock3 size={18} className="shrink-0 text-grey-600" aria-hidden="true" />;
  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-grey-100 py-3 last:border-b-0">
      {icon}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[15px] font-semibold text-navy-950 [overflow-wrap:anywhere]">{item.label}</span>
        <span className="text-[13px] text-grey-700">
          {item.status === "synced"
            ? `Synced ${formatWhen(item.syncedAt, timeZone)}`
            : item.status === "failed"
              ? (ERROR_TEXT[item.lastErrorCode ?? ""] ?? "Failed")
              : item.lastErrorCode ? `Waiting to retry: ${(ERROR_TEXT[item.lastErrorCode] ?? "error").toLowerCase()}` : "Waiting to sync"}
        </span>
      </div>
      {item.status === "failed" && canRetry ? (
        <form action={retryItemAction}>
          <input type="hidden" name="itemId" value={item.id} />
          <SubmitButton className={buttonClass("secondary", "sm", "min-h-11")} aria-label={`Retry ${item.label}`}>Retry</SubmitButton>
        </form>
      ) : null}
    </li>
  );
}

/**
 * Settings · Accounting (P5.10, Pro): connect Xero, QuickBooks or Sage (owners), choose the
 * organisation, see what has synced and what failed, Retry, Sync now (owners and managers), and
 * disconnect (owners; revokes at the provider, deletes the stored sign-in, keeps the history).
 */
export default async function AccountingSettingsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string; confirm?: string; choose?: string }> }) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  const { done, error, confirm } = await searchParams;
  const flash = FLASH[done ?? ""] ?? FLASH[error ?? ""];
  const garage = admin.garage;
  const isOwner = admin.role === "owner";
  const canSee = isOwner || admin.role === "manager";
  const canWrite = admin.mfaVerified && !admin.impersonation;

  if (!canSee) {
    return (
      <div className="flex flex-col gap-5 pb-10">
        <PageHeader eyebrow="Settings" title="Accounting" description="Invoices and payments sync to Xero, QuickBooks or Sage." />
        <Panel title="Owners and managers only">
          <p className="m-0 text-[14px] text-grey-700">Ask the garage owner or a manager about accounting sync.</p>
          <Link href="/app" className={buttonClass("secondary", "md", "w-fit")}>Back to today</Link>
        </Panel>
      </div>
    );
  }

  const overview = await loadAccountingOverview(admin.client, garage.id);
  const connection = overview.connection;

  if (!garageHasFeature(garage, "accounting_sync")) {
    return (
      <div className="flex flex-col gap-5">
        <ProLockedPage feature="accounting_sync" title="Accounting" canUpgrade={isOwner} hasExistingData={Boolean(connection) || overview.history > 0} />
        {connection && isOwner ? (
          <Panel title="Your old connection" id="connection">
            <p className="m-0 text-[14px] text-grey-700">
              {ACCOUNTING_PROVIDER_NAMES[connection.provider]}{connection.tenantName ? ` (${connection.tenantName})` : ""} is still linked but nothing syncs on Essentials. You can disconnect it.
            </p>
            <form action={disconnectAction}>
              <input type="hidden" name="confirm" value="yes" />
              <SubmitButton className={buttonClass("secondary", "md", "w-full sm:w-fit")} disabled={!canWrite}>Disconnect</SubmitButton>
            </form>
          </Panel>
        ) : null}
      </div>
    );
  }

  const mode = accountingMode();
  const keyReady = hasAccountingKey();
  const tenants = connection?.status === "pending" && isOwner ? (await listConnectionTenants(garage.id))?.tenants ?? [] : [];
  const providerName = connection ? getAccountingProvider(connection.provider).name : null;

  return (
    <div className="flex flex-col gap-5 pb-10">
      <PageHeader eyebrow="Settings" title="Accounting" description="Send invoices and payments to your accounting system as you issue and record them." />
      {flash ? <Notice tone={flash.tone} role={flash.tone === "error" ? "alert" : "status"}>{flash.text}</Notice> : null}
      {connection?.status === "needs_reconnect" ? (
        <Notice tone="warning" role="alert" id="reconnect-banner">
          {ACCOUNTING_PROVIDER_NAMES[connection.provider]} stopped accepting our connection, so syncing has paused.{" "}
          {isOwner ? "Reconnect below to carry on." : "Ask the owner to reconnect."} Nothing is lost: {overview.counts.pending} waiting to sync.
        </Notice>
      ) : null}
      {mode === "fake" ? (
        <Notice tone="info">Test mode: connections use Autofix&apos;s built-in test accounts. Nothing reaches a real accounting system.</Notice>
      ) : null}
      {isOwner && !admin.mfaVerified ? (
        <Notice tone="warning">
          To change the connection, verify your sign-in first.{" "}
          <Link href={`/app/mfa?returnTo=${encodeURIComponent(PATH)}&stepUp=1`} className="underline">Verify now</Link>
        </Notice>
      ) : null}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-5">
          {!connection ? (
            <Panel id="connection" title="Connect your accounts">
              <div className="flex flex-col gap-3">
                {REAL_ACCOUNTING_PROVIDERS.map((id) => {
                  const provider = getAccountingProvider(id);
                  const ready = provider.configured && keyReady;
                  return (
                    <div key={id} className="flex flex-col gap-3 rounded-input border border-grey-200 p-4 sm:flex-row sm:items-center">
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="flex flex-wrap items-center gap-2 text-[16px] font-bold text-navy-950">
                          {ACCOUNTING_PROVIDER_NAMES[id]}
                          {!ready ? <Badge tone="warning" size="xs">Configuration required</Badge> : null}
                        </span>
                        <span className="text-[14px] text-grey-700">{PROVIDER_BLURB[id]}</span>
                      </div>
                      {isOwner ? (
                        <form action={`/api/admin/accounting/${id}/connect`} method="post">
                          <button type="submit" className={buttonClass("primary", "md", "min-h-11 w-full sm:w-fit")} disabled={!ready || !canWrite}>
                            Connect {ACCOUNTING_PROVIDER_NAMES[id]}
                          </button>
                        </form>
                      ) : null}
                    </div>
                  );
                })}
                {!isOwner ? <p className="m-0 text-[14px] text-grey-700">Only the garage owner can connect accounting.</p> : null}
                <p className="m-0 text-[13px] text-grey-700">
                  You sign in on the provider&apos;s own page; Autofix never sees your password. Invoices issued before you connect are not sent.
                </p>
              </div>
            </Panel>
          ) : (
            <Panel id="connection" title="Connection" actions={statusBadge(connection)}>
              <div className="flex flex-col gap-4">
                <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[14px]">
                  <dt className="font-semibold text-grey-700">System</dt>
                  <dd className="m-0 text-navy-950">{providerName}</dd>
                  <dt className="font-semibold text-grey-700">Organisation</dt>
                  <dd className="m-0 text-navy-950 [overflow-wrap:anywhere]">{connection.tenantName ?? "Not chosen yet"}</dd>
                  <dt className="font-semibold text-grey-700">Connected</dt>
                  <dd className="m-0 text-navy-950">{formatWhen(connection.connectedAt, garage.timezone)}</dd>
                  <dt className="font-semibold text-grey-700">Last sync</dt>
                  <dd className="m-0 text-navy-950">{formatWhen(connection.lastSyncAt, garage.timezone)}</dd>
                </dl>

                {connection.status === "pending" ? (
                  isOwner ? (
                    <form action={chooseOrganisationAction} className="flex flex-col gap-3">
                      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                        <legend className="mb-2 text-[15px] font-bold text-navy-950">Which organisation should Autofix use?</legend>
                        {tenants.length === 0 ? <p className="m-0 text-[14px] text-grey-700">We couldn&apos;t load your organisations. Disconnect and connect again.</p> : null}
                        {tenants.map((tenant, index) => (
                          <label key={tenant.id} className="flex min-h-11 items-center gap-3 rounded-input border border-grey-200 px-3 text-[15px] text-navy-950">
                            <input type="radio" name="tenantId" value={tenant.id} defaultChecked={index === 0} className="size-5" />
                            <span className="[overflow-wrap:anywhere]">{tenant.name}</span>
                          </label>
                        ))}
                      </fieldset>
                      <SubmitButton className={buttonClass("primary", "md", "w-full sm:w-fit")} disabled={!canWrite || tenants.length === 0}>Use this organisation</SubmitButton>
                    </form>
                  ) : (
                    <p className="m-0 text-[14px] text-grey-700">The owner still needs to choose the organisation.</p>
                  )
                ) : null}

                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                  {connection.status === "connected" ? (
                    <form action={syncNowAction}>
                      <SubmitButton className={buttonClass("primary", "md", "w-full sm:w-fit")} disabled={!canWrite}>
                        <span className="inline-flex items-center gap-2"><RefreshCw size={16} aria-hidden="true" />Sync now</span>
                      </SubmitButton>
                    </form>
                  ) : null}
                  {connection.status === "needs_reconnect" && isOwner && connection.provider !== "fake" ? (
                    <form action={`/api/admin/accounting/${connection.provider}/connect`} method="post">
                      <button type="submit" className={buttonClass("primary", "md", "min-h-11 w-full sm:w-fit")} disabled={!canWrite}>
                        Reconnect {ACCOUNTING_PROVIDER_NAMES[connection.provider]}
                      </button>
                    </form>
                  ) : null}
                  {isOwner && confirm !== "disconnect" ? (
                    <form action={disconnectAction}>
                      <SubmitButton className={buttonClass("ghost", "md", "w-full sm:w-fit")} disabled={!canWrite}>Disconnect</SubmitButton>
                    </form>
                  ) : null}
                </div>
                {isOwner && confirm === "disconnect" ? (
                  <form action={disconnectAction} className="flex flex-col gap-3 rounded-input border border-grey-200 bg-grey-50 p-3">
                    <p className="m-0 text-[14px] text-navy-950">
                      Disconnect {ACCOUNTING_PROVIDER_NAMES[connection.provider]}? We sign Autofix out of it and delete the stored sign-in. What already synced stays in your accounts, and the history stays here.
                    </p>
                    <input type="hidden" name="confirm" value="yes" />
                    <div className="flex flex-wrap gap-2">
                      <SubmitButton className={buttonClass("secondary", "md")} disabled={!canWrite}>Yes, disconnect</SubmitButton>
                      <Link href={PATH} className={buttonClass("ghost", "md")}>Keep it</Link>
                    </div>
                  </form>
                ) : null}
              </div>
            </Panel>
          )}

          {connection ? (
            <Panel id="failed" title="Needs attention" count={overview.counts.failed} countLabel="failed">
              {overview.failed.length ? (
                <ul className="m-0 list-none p-0">
                  {overview.failed.map((item) => <ItemRow key={item.id} item={item} timeZone={garage.timezone} canRetry={canWrite && connection.status === "connected"} />)}
                </ul>
              ) : (
                <p className="m-0 text-[14px] text-grey-700">Nothing has failed.</p>
              )}
            </Panel>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <Panel id="status" title="Sync status">
            <div className="flex flex-col gap-4">
              <dl className="m-0 grid grid-cols-3 gap-2 text-center">
                {([
                  ["Synced", overview.counts.synced],
                  ["Waiting", overview.counts.pending],
                  ["Failed", overview.counts.failed],
                ] as const).map(([label, value]) => (
                  <div key={label} className="flex flex-col rounded-input bg-grey-50 px-2 py-3">
                    <dt className="text-[13px] font-semibold text-grey-700">{label}</dt>
                    <dd className="m-0 font-display text-[24px] font-extrabold text-navy-950">{value}</dd>
                  </div>
                ))}
              </dl>
              {overview.recent.length ? (
                <ul className="m-0 list-none p-0" aria-label="Recent">
                  {overview.recent.map((item) => <ItemRow key={item.id} item={item} timeZone={garage.timezone} canRetry={false} />)}
                </ul>
              ) : (
                <p className="m-0 text-[14px] text-grey-700">Invoices sync when you issue them and payments when you record them.</p>
              )}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
