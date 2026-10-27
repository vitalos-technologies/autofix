import type { Metadata } from "next";
import Link from "next/link";
import { Download, QrCode, Trash2 } from "lucide-react";
import {
  Badge,
  buttonClass,
  CopyButton,
  DnsRecordTable,
  DomainStatusSteps,
  EmbedSnippet,
  PageHeader,
  Panel,
  StepNumber,
  textLinkClass,
} from "@/components/admin-ui";
import { garageInitials } from "@/components/book";
import { askbridgeFromSettings, askbridgeScriptUrl } from "@/lib/askbridge/config";
import { accentForWhiteText } from "@/lib/branding/accent";
import { checkAvailableInMs, dnsRecordsForDisplay, failedStepFor, isDomainInProgress } from "@/lib/booking-page/domain-view";
import { getCustomDomain } from "@/lib/booking-page/domains-server";
import { embedOriginsFromSettings } from "@/lib/booking-page/embed-origins";
import { qrSvg } from "@/lib/booking-page/qr";
import { canChangeGarage } from "@/lib/settings/setup";
import { getAdminContext } from "@/lib/tenancy/admin";
import { garageBaseUrl } from "@/lib/tenancy/urls";
import { getDomainCnameTarget } from "@/lib/vercel/domains";
import { FlashMessage, ReadOnlyNotice, SetupNav, SetupNotice } from "../_components/setup-nav";
import { removeDomainAction } from "./actions";
import { AskbridgeForm, CheckDomainForm, ConnectDomainForm, EmbedOriginsForm } from "./booking-page-forms";

export const metadata: Metadata = { title: "Booking page" };

const MESSAGES: Record<string, string> = {
  "done:domain_connected": "Address added. Now add the record below at your domain provider; we check for it every few minutes.",
  "done:domain_queued": "Address added. Our hosting provider is busy, so we'll finish setting it up in a few minutes. Add the record below in the meantime.",
  "done:domain_removed": "Address removed. Customers use your free link again.",
  "error:not_allowed": "Only the garage owner can change the booking page.",
  "error:no_domain": "There is no address to remove.",
  "error:save_failed": "That change could not be saved. Try again.",
};

const STATUS_BADGE = {
  pending_dns: { tone: "warning", label: "Waiting for the record" },
  verifying: { tone: "warning", label: "Securing" },
  active: { tone: "success", label: "Live" },
  failed: { tone: "danger", label: "Not connected" },
} as const;

type PageProps = { searchParams: Promise<{ done?: string | string[]; error?: string | string[] }> };

function emailStepsHref(hostname: string, records: Array<{ type: string; name: string; value: string }>) {
  const lines = [
    `Hello,`,
    ``,
    `Please add ${records.length === 1 ? "this DNS record" : "these DNS records"} so our online booking page works at ${hostname}:`,
    ``,
    ...records.map((record) => `${record.type}  name: ${record.name}  value: ${record.value}`),
    ``,
    `If the domain uses Cloudflare, set the record to "DNS only" (grey cloud). Thank you.`,
  ];
  return `mailto:?subject=${encodeURIComponent(`DNS record for ${hostname}`)}&body=${encodeURIComponent(lines.join("\n"))}`;
}

/** Setup · Booking page: free link and QR code, own web address (DNS + status), embed code, Askbridge chat. */
export default async function BookingPageSettings({ searchParams }: PageProps) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  const query = await searchParams;
  if (!admin) {
    return (
      <div className="flex flex-col gap-5 pb-10">
        <PageHeader eyebrow="Setup" title="Booking page" />
        <SetupNotice tone="warning">Sign in to see your booking page settings.</SetupNotice>
      </div>
    );
  }
  const { garage } = admin;
  const canEdit = canChangeGarage(admin.role);
  const [settingsRow, domain] = await Promise.all([
    admin.client.from("garages").select("settings").eq("id", garage.id).maybeSingle(),
    getCustomDomain(admin.client, garage.id).catch(() => null),
  ]);
  const settings = settingsRow.data?.settings ?? null;
  const embedOrigins = embedOriginsFromSettings(settings);
  const askbridge = askbridgeFromSettings(settings);
  const widgetAvailable = askbridgeScriptUrl() !== null;

  const freeUrl = garageBaseUrl({ slug: garage.slug });
  const freeHost = freeUrl.replace(/^https?:\/\//, "");
  const bookingUrl = garageBaseUrl({ slug: garage.slug, customDomain: garage.customDomain });
  const qr = qrSvg(`${bookingUrl}/`, { title: `QR code for ${bookingUrl.replace(/^https?:\/\//, "")}` });
  const records = domain ? dnsRecordsForDisplay(domain, getDomainCnameTarget()) : [];
  const domainLive = domain?.status === "active";
  const waitMinutes = domain ? Math.ceil(checkAvailableInMs(domain.lastCheckedAt) / 60_000) : 0;

  return (
    <div className="flex flex-col gap-5 pb-10">
      <PageHeader eyebrow="Setup" title="Booking page" description="Where customers book. Use our free link today, then move it to your own web address." />
      <SetupNav current="booking-page" />
      <FlashMessage messages={MESSAGES} done={query.done} error={query.error} />
      {!canEdit ? <ReadOnlyNotice level="owner" /> : null}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-5">
          <Panel id="free-link" title="Your free link" leading={<StepNumber step={1} state="done" />} actions={<Badge tone="success">Live</Badge>}>
            <div className="flex flex-wrap items-center gap-2.5">
              <code className="min-w-0 flex-[1_1_280px] rounded-input border border-grey-200 bg-grey-50 px-3.5 py-3 font-mono text-[14px] font-medium break-all text-navy-950">{freeHost}</code>
              <CopyButton value={`${freeUrl}/`} srSuffix={`free link ${freeHost}`} className="w-full sm:w-auto" />
              <details className="group w-full sm:w-auto open:sm:w-full">
                <summary className={buttonClass("secondary", "md", "w-full list-none sm:w-auto [&::-webkit-details-marker]:hidden")}>
                  <QrCode size={16} strokeWidth={2} aria-hidden="true" />
                  <span className="group-open:hidden">Show QR code</span>
                  <span className="hidden group-open:inline">Hide QR code</span>
                </summary>
                <div className="mt-3 flex flex-wrap items-center gap-4 rounded-input border border-grey-200 p-3.5">
                  <div className="size-40 shrink-0 rounded-[10px] bg-white" dangerouslySetInnerHTML={{ __html: qr }} />
                  <div className="flex min-w-0 flex-[1_1_200px] flex-col gap-2.5">
                    <p className="m-0 text-[14px] leading-snug text-grey-700">
                      Print it on job sheets, invoices or a sign at reception. It opens{" "}
                      <span className="font-semibold break-all text-navy-950">{bookingUrl.replace(/^https?:\/\//, "")}</span>.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <a href="/app/settings/booking-page/qr?format=png" download className={buttonClass("secondary", "sm")}>
                        <Download size={15} strokeWidth={2} aria-hidden="true" />
                        Download PNG
                      </a>
                      <a href="/app/settings/booking-page/qr?format=svg" download className={buttonClass("secondary", "sm")}>
                        <Download size={15} strokeWidth={2} aria-hidden="true" />
                        Download SVG
                      </a>
                    </div>
                  </div>
                </div>
              </details>
            </div>
          </Panel>

          <Panel
            id="own-address"
            title="Use your own address"
            highlight={!domainLive}
            leading={<StepNumber step={2} state={domainLive ? "done" : "current"} />}
            actions={domain ? <Badge tone={STATUS_BADGE[domain.status].tone}>{STATUS_BADGE[domain.status].label}</Badge> : null}
          >
            {domain ? (
              <>
                <p className="m-0 text-[15px] text-grey-800">
                  Web address <span className="font-mono font-medium break-all text-navy-950">{domain.hostname}</span>
                </p>
                {domainLive ? (
                  <p className="m-0 text-[14px] text-grey-700">
                    Customers book at{" "}
                    <a href={`https://${domain.hostname}/`} className={textLinkClass} target="_blank" rel="noreferrer">
                      {domain.hostname}
                    </a>
                    . Your free link keeps working too.
                  </p>
                ) : (
                  <>
                    <p className="m-0 text-[14px] text-grey-700">
                      Add {records.length === 1 ? "this one record" : "these records"} where your domain is managed (GoDaddy, 123 Reg, IONOS, Cloudflare…):
                    </p>
                    <DnsRecordTable records={records} caption={`DNS records for ${domain.hostname}`} />
                  </>
                )}
                <DomainStatusSteps status={domain.status} error={domain.error} failedStep={failedStepFor(domain.error)} hostname={domain.hostname} />
                {isDomainInProgress(domain.status) || domain.status === "failed" ? (
                  <CheckDomainForm retry={domain.status === "failed"} canEdit={canEdit} waitMinutes={waitMinutes} />
                ) : null}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  {!domainLive ? (
                    <a href={emailStepsHref(domain.hostname, records)} className={textLinkClass}>
                      Not sure how? Email these steps to whoever looks after your website
                    </a>
                  ) : (
                    <span />
                  )}
                  {canEdit ? (
                    <form action={removeDomainAction}>
                      <button type="submit" className={buttonClass("ghost", "sm")}>
                        <Trash2 size={15} strokeWidth={2} aria-hidden="true" />
                        Remove {domain.hostname}
                      </button>
                    </form>
                  ) : null}
                </div>
              </>
            ) : (
              <ConnectDomainForm canEdit={canEdit} />
            )}
          </Panel>

          <Panel id="website" title="Add it to your website" leading={<StepNumber step={3} state="upcoming" />}>
            <EmbedSnippet bookingUrl={bookingUrl} accent={garage.accent} garageName={garage.name} />
            <EmbedOriginsForm origins={embedOrigins} canEdit={canEdit} />
          </Panel>
        </div>

        <aside aria-label="Branding and chat" className="flex min-w-0 flex-col gap-5">
          <Panel id="branding" title="Your branding">
            <div className="flex items-center gap-3">
              {garage.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- the garage's own uploaded file
                <img src={garage.logoUrl} alt={`${garage.name} logo`} className="size-14 rounded-[14px] border border-grey-200 bg-white object-contain" />
              ) : (
                <span
                  aria-hidden="true"
                  style={{ background: accentForWhiteText(garage.accent) }}
                  className="flex size-14 items-center justify-center rounded-[14px] font-display text-[26px] font-extrabold text-white"
                >
                  {garageInitials(garage.name)}
                </span>
              )}
              <div className="flex min-w-0 flex-col gap-1 text-[14px] text-grey-700">
                <span className="flex items-center gap-2">
                  <span aria-hidden="true" className="size-5 rounded-full border border-grey-200" style={{ background: garage.accent }} />
                  Brand colour <span className="font-mono text-navy-950">{garage.accent}</span>
                </span>
                <span>MOT bookings and reminders: {garage.motEnabled ? "on" : "off"}</span>
              </div>
            </div>
            <Link href="/app/settings/branding" className={buttonClass("secondary", "md", "w-full")}>
              Change branding
            </Link>
          </Panel>

          <Panel id="askbridge" title="Askbridge chat" actions={askbridge.enabled ? <Badge tone="success">On</Badge> : <Badge tone="muted">Off</Badge>}>
            <p className="m-0 text-[14px] leading-snug text-grey-700">
              An AI front desk on your booking page. It answers questions from your services, prices, opening hours and FAQs, and sends customers to book here.
            </p>
            {!widgetAvailable ? <SetupNotice>Askbridge isn&apos;t connected to Autofix yet. You can save your widget ID now; the chat appears once it is.</SetupNotice> : null}
            <AskbridgeForm enabled={askbridge.enabled} widgetId={askbridge.widgetId} canEdit={canEdit} />
          </Panel>
        </aside>
      </div>
    </div>
  );
}
