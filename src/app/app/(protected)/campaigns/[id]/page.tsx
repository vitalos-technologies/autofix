import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, Users } from "lucide-react";
import { PlateChip } from "@/components/book";
import {
  buttonClass,
  ChannelBadge,
  DataTable,
  EmptyState,
  KpiCard,
  KpiGrid,
  MessagePreview,
  PageHeader,
  Panel,
  StatusPill,
  SubmitButton,
  textLinkClass,
  type DataTableColumn,
} from "@/components/admin-ui";
import { ProLockedCard } from "@/components/plans";
import { DEFAULT_TIME_ZONE } from "@/lib/admin/dates";
import { formatWholePounds } from "@/lib/admin/today";
import {
  EMPTY_RESULTS,
  loadCampaign,
  loadCampaignResults,
  loadCampaignServices,
  loadRecipients,
  previewAudience,
  type RecipientRow,
} from "@/lib/campaigns/admin";
import { describeSegment } from "@/lib/campaigns/segment";
import { campaignSampleValues } from "@/lib/campaigns/templates";
import { campaignStatusPill, formatSendTime, localInputValue, recipientPill } from "@/lib/campaigns/view";
import { garageHasFeature } from "@/lib/plans/server";
import { canManageSetup } from "@/lib/settings/setup";
import { getAdminContext } from "@/lib/tenancy/admin";
import { garageBaseUrl } from "@/lib/tenancy/urls";
import { cn } from "@/lib/utils";
import { formatRegistration } from "@/lib/vehicle/registration-format";
import { FlashMessage, ReadOnlyNotice } from "../../settings/_components/setup-nav";
import { cancelCampaignAction, deleteCampaignAction } from "../actions";
import { CampaignEditor } from "../campaign-editor";
import { CampaignTestForm, ScheduleForm } from "../send-forms";

export const metadata: Metadata = { title: "Campaign" };

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ done?: string | string[]; error?: string | string[] }>;
};

const twoColumns = "flex flex-wrap items-start gap-[18px]";
const mainColumn = "flex min-w-0 flex-[999_1_520px] flex-col gap-[18px]";
const sideColumn = "flex min-w-0 flex-[1_1_300px] flex-col gap-[18px]";

const MESSAGES: Record<string, string> = {
  "done:saved": "Draft saved. Send yourself a test, then choose when it goes.",
  "done:sending": "Sending now. Messages go out over the next few minutes (09:00–19:00, Monday to Saturday).",
  "done:scheduled": "Scheduled. It goes at the time you picked.",
  "done:cancelled": "Campaign stopped. Messages already sent stay sent.",
  "error:not_allowed": "Only the garage's owners and managers can change campaigns.",
  "error:plan_required": "Campaigns are part of Pro.",
  "error:not_draft": "This campaign has been scheduled already.",
  "error:template": "Fix the message before sending.",
  "error:bad_time": "Pick a real date and time within the next year.",
  "error:past_time": "That time has passed. Pick a time from now on.",
  "error:empty": "Nobody matches this campaign yet, so there is nobody to send it to. Widen the filters.",
  "error:mot_off": "MOT months need MOTs switched on in Branding & MOT.",
  "error:save_failed": "That could not be done. Try again.",
  "error:cancel_failed": "The campaign could not be stopped. Try again.",
  "error:delete_failed": "Only drafts can be deleted.",
};

const recipientColumns: DataTableColumn<RecipientRow>[] = [
  {
    key: "name",
    header: "Customer",
    rowHeader: true,
    cell: (row) => (
      <Link href={`/app/customers/${row.customerId}`} className={cn(textLinkClass, "-my-[11px] font-semibold text-inherit")}>
        {row.name}
      </Link>
    ),
  },
  { key: "contact", header: "Contact", cell: (row) => <span className="tabular-nums">{row.contact}</span> },
  {
    key: "car",
    header: "Car",
    cell: (row) => (row.registration ? <PlateChip registration={formatRegistration(row.registration)} className="rounded-[4px] px-1.5 py-px text-[14px]" /> : "Car"),
  },
  { key: "channel", header: "By", cell: (row) => <ChannelBadge channel={row.channel} /> },
  {
    key: "status",
    header: "Status",
    cell: (row) => {
      const pill = recipientPill(row);
      return <StatusPill status={pill.status} label={pill.label} size="sm" />;
    },
  },
];

/** One campaign (P5.5): a draft's editor with test and schedule, or a sent campaign's results and recipients. */
export default async function CampaignPage({ params, searchParams }: PageProps) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  const { id } = await params;
  const query = await searchParams;
  const campaign = await loadCampaign(admin.client, admin.garage.id, id);
  if (!campaign) notFound();

  const timeZone = admin.garage.timezone || DEFAULT_TIME_ZONE;
  const pro = garageHasFeature(admin.garage, "campaigns");
  const canEdit = canManageSetup(admin.role);
  const services = await loadCampaignServices(admin.client, admin.garage.id, admin.garage.motEnabled);
  const serviceName = (serviceId: string) => services.find((service) => service.id === serviceId)?.name;
  const sampleValues = campaignSampleValues({ garageName: admin.garage.name, bookingBaseUrl: garageBaseUrl(admin.garage) });
  const pill = campaignStatusPill(campaign.status);
  const header = (
    <>
      <Link href="/app/campaigns" className={cn(textLinkClass, "inline-flex min-h-11 items-center gap-1.5 self-start text-[14px] font-semibold")}>
        <ArrowLeft size={16} strokeWidth={2} aria-hidden="true" />
        Campaigns
      </Link>
      <PageHeader
        eyebrow={<StatusPill status={pill.status} label={pill.label} size="sm" />}
        title={campaign.name}
        description={
          campaign.sendAt
            ? `${campaign.status === "scheduled" ? "Goes" : "Went"} ${formatSendTime(campaign.sendAt, timeZone)} to ${campaign.recipients ?? 0} ${campaign.recipients === 1 ? "customer" : "customers"}.`
            : "Draft: not sent yet."
        }
      />
      <FlashMessage messages={MESSAGES} done={query.done} error={query.error} />
    </>
  );

  if (campaign.status === "draft") {
    const editable = canEdit && pro;
    const preview = editable ? await previewAudience(admin.client, campaign.segment, 8) : null;
    const now = new Date();
    return (
      <div className="flex flex-col gap-[22px] pb-10">
        {header}
        {!pro ? <ProLockedCard feature="campaigns" canUpgrade={admin.role === "owner"} hasExistingData /> : null}
        {!canEdit ? <ReadOnlyNotice level="manage" /> : null}
        <div className={twoColumns}>
          <div className={mainColumn}>
            {editable ? (
              <CampaignEditor
                values={{
                  id: campaign.id,
                  starter: campaign.starter,
                  name: campaign.name,
                  segment: campaign.segment,
                  template: campaign.template,
                  emailSubject: campaign.emailSubject,
                  emailTemplate: campaign.emailTemplate ?? "",
                  serviceId: campaign.serviceId ?? "",
                }}
                services={services}
                motEnabled={admin.garage.motEnabled}
                sampleValues={sampleValues}
                senderName={admin.garage.name}
                initialPreview={preview?.ok ? preview.preview : null}
              />
            ) : (
              <Panel title="Message">
                <MessagePreview template={campaign.template} values={sampleValues} senderName={admin.garage.name} />
              </Panel>
            )}
          </div>
          {editable ? (
            <aside aria-label="Send" className={sideColumn}>
              <Panel title="Send" className="gap-4">
                {preview?.ok && preview.preview.total > 0 ? (
                  <ScheduleForm
                    id={campaign.id}
                    recipients={preview.preview.total}
                    defaultAt={localInputValue(new Date(now.getTime() + 24 * 3_600_000), timeZone).slice(0, 11) + "10:00"}
                    minAt={localInputValue(now, timeZone)}
                    timeZoneLabel="UK time"
                  />
                ) : preview?.ok ? (
                  <p className="m-0 text-[14px] text-grey-700">Nobody matches this campaign yet. Widen the filters and save the draft to send it.</p>
                ) : (
                  <p role="alert" className="m-0 text-[14px] font-semibold text-[#991b1b]">
                    Who this goes to couldn&apos;t be worked out. Refresh the page to try again.
                  </p>
                )}
                <CampaignTestForm id={campaign.id} />
              </Panel>
              <Panel title="Delete draft" headingLevel={2} className="gap-2.5">
                <form action={deleteCampaignAction} className="flex flex-col gap-2">
                  <input type="hidden" name="id" value={campaign.id} />
                  <SubmitButton className={buttonClass("secondary", "md", "w-full")}>Delete this draft</SubmitButton>
                </form>
              </Panel>
            </aside>
          ) : null}
        </div>
      </div>
    );
  }

  const [results, recipients] = await Promise.all([loadCampaignResults(admin.client, campaign.id), loadRecipients(admin.client, admin.garage.id, campaign.id)]);
  const figures = results?.get(campaign.id) ?? EMPTY_RESULTS;

  return (
    <div className="flex flex-col gap-[22px] pb-10">
      {header}
      {results ? (
        <KpiGrid label="Results">
          <KpiCard size="sm" label="Sent" value={String(figures.sent)} secondaryValue={figures.scheduled > 0 ? `${figures.scheduled} to go` : undefined} />
          <KpiCard size="sm" label="Delivered" value={String(figures.delivered)} />
          <KpiCard size="sm" label="Opened the link" value={String(figures.opened)} />
          <KpiCard size="sm" label="Bookings" value={String(figures.bookings)} />
          <KpiCard size="sm" label="Won" value={formatWholePounds(figures.pence)} tone="navy" />
        </KpiGrid>
      ) : (
        <p role="alert" className="m-0 text-[14px] font-semibold text-[#991b1b]">
          The results could not be loaded. Refresh the page to try again.
        </p>
      )}
      <div className={twoColumns}>
        <div className={mainColumn}>
          <Panel title="Recipients" count={recipients?.length} className="gap-2.5">
            {recipients === null ? (
              <p role="alert" className="m-0 text-[14px] font-semibold text-[#991b1b]">
                The recipients could not be loaded. Refresh the page to try again.
              </p>
            ) : recipients.length > 0 ? (
              <DataTable caption="Who this campaign went to" columns={recipientColumns} rows={recipients} getRowKey={(row) => row.id} minWidth={640} />
            ) : (
              <EmptyState icon={Users} title="No recipients" />
            )}
          </Panel>
        </div>
        <aside aria-label="Campaign details" className={sideColumn}>
          <Panel title="Message">
            <MessagePreview template={campaign.template} values={sampleValues} senderName={admin.garage.name} />
          </Panel>
          <Panel title="Who it went to" className="gap-2">
            <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[14px] text-grey-800">
              {describeSegment(campaign.segment, { serviceName }).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Panel>
          {canEdit && (campaign.status === "scheduled" || campaign.status === "sending") ? (
            <Panel title="Stop the campaign" className="gap-2.5">
              <p className="m-0 text-[14px] text-grey-700">Messages that haven&apos;t gone yet won&apos;t be sent. Messages already sent stay sent.</p>
              <form action={cancelCampaignAction}>
                <input type="hidden" name="id" value={campaign.id} />
                <SubmitButton className={buttonClass("secondary", "md", "w-full")}>Stop sending</SubmitButton>
              </form>
            </Panel>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
