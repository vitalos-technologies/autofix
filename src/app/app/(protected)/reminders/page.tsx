import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BellRing } from "lucide-react";
import { PlateChip } from "@/components/book";
import {
  AutomationRow,
  buttonClass,
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
import { addDays, DEFAULT_TIME_ZONE, formatDayMonth, localDateKey, monthStart } from "@/lib/admin/dates";
import { bookedShare, KIND_LABELS, type DueRow } from "@/lib/admin/reminder-view";
import { loadDueSoon, loadReminderMonth, loadReminderRules, type ReminderRule } from "@/lib/admin/reminders";
import { formatWholePounds } from "@/lib/admin/today";
import {
  defaultTemplate,
  describeRule,
  REVIEW_CONSENT_NOTE,
  RULE_KINDS,
  RULE_NAMES,
  RULE_SWITCH_LABELS,
  sampleTemplateValues,
  type RuleKind,
} from "@/lib/reminders/rules";
import { canManageSetup } from "@/lib/settings/setup";
import { getAdminContext } from "@/lib/tenancy/admin";
import { garageBaseUrl } from "@/lib/tenancy/urls";
import { cn } from "@/lib/utils";
import { formatReminderDate } from "@/lib/reminders/compose";
import { formatRegistration } from "@/lib/vehicle/registration-format";
import { FlashMessage, ReadOnlyNotice, SetupNotice } from "../settings/_components/setup-nav";
import { toggleRuleAction } from "./actions";
import { RuleEditor } from "./rule-editor";
import { TestSendForm } from "./test-send-form";

export const metadata: Metadata = { title: "Reminders" };

type PageProps = {
  searchParams: Promise<{ edit?: string | string[]; confirm?: string | string[]; done?: string | string[]; error?: string | string[] }>;
};

const twoColumns = "flex flex-wrap items-start gap-[18px]";
const mainColumn = "flex min-w-0 flex-[999_1_520px] flex-col gap-[18px]";
const sideColumn = "flex min-w-0 flex-[1_1_300px] flex-col gap-[18px]";

const DEFAULT_OFFSETS: Record<RuleKind, number[]> = { mot: [28, 7], service: [335], review: [1], missed_call: [0] };

const MESSAGES: Record<string, string> = {
  ...Object.fromEntries(
    RULE_KINDS.flatMap((kind) => [
      [`done:${kind}_on`, `${RULE_SWITCH_LABELS[kind]} switched on.${kind === "missed_call" ? "" : " Cars that are due get planned within a few minutes."}`],
      [`done:${kind}_off`, `${RULE_SWITCH_LABELS[kind]} switched off. Nothing more goes out for it.`],
    ]),
  ),
  "error:not_allowed": "Only the garage's owners and managers can change reminders.",
  "error:not_found": "That automation could not be found. Reload the page and try again.",
  "error:mot_off": "MOT reminders need MOTs switched on in Branding & MOT first.",
  "error:save_failed": "That change could not be saved. Try again.",
};

function one(value: string | string[] | undefined) {
  return typeof value === "string" ? value : undefined;
}

function previewChannel(rule: Pick<ReminderRule, "channel">) {
  return rule.channel === "whatsapp" ? "whatsapp" : rule.channel === "email" ? "email" : "sms";
}

function previewNotes(kind: RuleKind): string[] {
  if (kind === "missed_call") {
    return [
      "Goes to callers we couldn't answer, at any time of day: it's a reply, not a reminder.",
      "Only to mobiles, never to someone who replied STOP, and once per call.",
      "The link opens your booking page.",
    ];
  }
  return [
    "Link opens the booking page with the car already filled in.",
    "Sends 09:00–19:00 only, never on Sundays.",
    "Only to customers who agreed to reminders, from your garage's number, so they can reply STOP.",
  ];
}

function dueColumns(currentYear: number): DataTableColumn<DueRow>[] {
  return [
    {
      key: "customer",
      header: "Customer",
      rowHeader: true,
      cell: (row) =>
        row.customerId ? (
          <Link href={`/app/customers/${row.customerId}`} className={cn(textLinkClass, "-my-[11px] font-semibold text-inherit")}>
            {row.customerName}
          </Link>
        ) : (
          row.customerName
        ),
    },
    {
      key: "car",
      header: "Car",
      cell: (row) => (row.registration ? <PlateChip registration={formatRegistration(row.registration)} className="rounded-[4px] px-1.5 py-px text-[14px]" /> : "Car"),
    },
    { key: "due", header: "Due", cell: (row) => formatDayMonth(row.dueDate, currentYear) },
    { key: "type", header: "Type", cell: (row) => KIND_LABELS[row.kind] },
    { key: "status", header: "Status", cell: (row) => <StatusPill status={row.status} label={row.label} size="sm" /> },
  ];
}

/** Reminders (Admin-Reminders): this month's figures, the automations, what's due and the wording. */
export default async function RemindersPage({ searchParams }: PageProps) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  const query = await searchParams;
  const timeZone = admin.garage.timezone || DEFAULT_TIME_ZONE;
  const today = localDateKey(new Date(), timeZone);
  const currentYear = Number(today.slice(0, 4));
  const motEnabled = admin.garage.motEnabled;
  const canEdit = canManageSetup(admin.role);

  const rules = await loadReminderRules(admin.client, admin.garage.id);
  const byKind = new Map((rules ?? []).map((rule) => [rule.kind, rule]));
  const kinds = RULE_KINDS.filter((kind) => kind !== "mot" || motEnabled);
  const ruleFor = (kind: RuleKind): ReminderRule =>
    byKind.get(kind) ?? { id: "", kind, enabled: false, offsetDays: DEFAULT_OFFSETS[kind], channel: "customer", template: defaultTemplate(kind), updatedAt: null };

  const [month, due] = await Promise.all([
    loadReminderMonth(admin.client, admin.garage.id, monthStart(today), timeZone),
    loadDueSoon(admin.client, admin.garage.id, { today, timeZone, motEnabled, motRuleOn: Boolean(byKind.get("mot")?.enabled) }),
  ]);

  const editParam = one(query.edit);
  const editKind = kinds.find((kind) => kind === editParam) ?? null;
  const confirmReview = canEdit && one(query.confirm) === "review" && !byKind.get("review")?.enabled;
  const previewKind: RuleKind = editKind ?? (motEnabled ? "mot" : "service");
  const previewRule = ruleFor(previewKind);
  const bookingBaseUrl = garageBaseUrl(admin.garage);
  const sampleDue = addDays(today, 28);
  const samples = (kind: RuleKind) => sampleTemplateValues({ kind, garageName: admin.garage.name, bookingBaseUrl, dueDate: formatReminderDate(sampleDue) });
  const share = month ? bookedShare(month.booked, month.sent) : null;

  return (
    <div className="flex flex-col gap-[22px] pb-10">
      <PageHeader
        title="Reminders"
        description="Automatic texts that bring customers back. They only go to people who opted in, and every message has a one-tap opt-out."
        actions={
          canEdit ? (
            <Link href="/app/customers/import" className={buttonClass("secondary")}>
              Import customer list
            </Link>
          ) : undefined
        }
      />
      <FlashMessage messages={MESSAGES} done={query.done} error={query.error} />
      {!canEdit ? <ReadOnlyNotice level="manage" /> : null}

      {confirmReview ? (
        <Panel id="review-confirm" title="Switch on review requests?" highlight className="scroll-mt-4">
          <p className="m-0 text-[14px] leading-normal text-grey-800">{REVIEW_CONSENT_NOTE}</p>
          <p className="m-0 text-[14px] leading-normal text-grey-700">
            When they&apos;re on, a request goes the day after a car is collected, only to customers who agreed to reminders, and anyone can stop them by
            replying STOP.
          </p>
          <div className="flex flex-wrap gap-2.5">
            <form action={toggleRuleAction} className="flex flex-1 sm:flex-none">
              <input type="hidden" name="kind" value="review" />
              <input type="hidden" name="enabled" value="true" />
              <input type="hidden" name="confirmed" value="yes" />
              <SubmitButton className={buttonClass("primary", "md", "w-full")}>Switch on review requests</SubmitButton>
            </form>
            <Link href="/app/reminders" className={buttonClass("secondary", "md", "flex-1 sm:flex-none")}>
              Keep them off
            </Link>
          </div>
        </Panel>
      ) : null}

      {month ? (
        <KpiGrid label="This month">
          <KpiCard size="sm" label="Sent this month" value={String(month.sent)} />
          <KpiCard size="sm" label="Booked from a reminder" value={String(month.booked)} secondaryValue={share ?? undefined} />
          <KpiCard size="sm" label="Revenue won back" value={formatWholePounds(month.pence)} tone="navy" />
          <KpiCard size="sm" label="Opted out" value={String(month.optedOut)} />
        </KpiGrid>
      ) : (
        <SetupNotice tone="danger">This month&apos;s reminder figures could not be loaded. Refresh the page to try again.</SetupNotice>
      )}

      <div className={twoColumns}>
        <div className={mainColumn}>
          <Panel title="Automations" padding="flush" className="gap-1">
            {rules ? (
              <div className="flex flex-col">
                {kinds.map((kind, index) => {
                  const rule = ruleFor(kind);
                  const description = describeRule(kind, rule.offsetDays);
                  return (
                    <AutomationRow
                      key={kind}
                      name={RULE_NAMES[kind]}
                      description={kind === "mot" ? `${description} · dates checked against DVSA nightly` : description}
                      channel={rule.channel}
                      editHref={`/app/reminders?edit=${kind}#rule-editor`}
                      editLabel={canEdit ? "Edit" : "View"}
                      enabled={rule.enabled}
                      switchLabel={RULE_SWITCH_LABELS[kind]}
                      toggleAction={toggleRuleAction}
                      fields={{ kind }}
                      disabled={!canEdit}
                      divider={index < kinds.length - 1}
                    />
                  );
                })}
              </div>
            ) : (
              <p role="alert" className="m-0 py-3 text-[14px] font-semibold text-[#991b1b]">
                The automations could not be loaded. Refresh the page to try again.
              </p>
            )}
          </Panel>

          <Panel title="Due in the next 30 days" className="gap-2.5">
            {due === null ? (
              <p role="alert" className="m-0 text-[14px] font-semibold text-[#991b1b]">
                What&apos;s due could not be loaded. Refresh the page to try again.
              </p>
            ) : due.length > 0 ? (
              <DataTable
                caption={motEnabled ? "MOTs and services due in the next 30 days" : "Services due in the next 30 days"}
                columns={dueColumns(currentYear)}
                rows={due}
                getRowKey={(row) => row.key}
                isRowMuted={(row) => row.muted}
                minWidth={600}
              />
            ) : (
              <EmptyState
                icon={BellRing}
                title="Nothing due in the next 30 days"
                description={`Customers' cars show up here when their ${motEnabled ? "MOT or service" : "service"} falls due, with whether a reminder will go.`}
              />
            )}
          </Panel>
        </div>

        <aside aria-label={editKind ? "Edit automation" : "Message preview"} className={sideColumn}>
          {editKind ? (
            <Panel id="rule-editor" title={canEdit ? `Edit: ${RULE_NAMES[editKind]}` : RULE_NAMES[editKind]} className="scroll-mt-4">
              <RuleEditor
                key={editKind}
                kind={editKind}
                template={previewRule.template}
                offsets={previewRule.offsetDays}
                channel={previewRule.channel}
                sampleValues={samples(editKind)}
                senderName={admin.garage.name}
                canEdit={canEdit}
              />
              {canEdit ? <TestSendForm kind={editKind} hint="Sends the saved message, with the sample details, to your own mobile or email." /> : null}
            </Panel>
          ) : (
            <Panel id="message-preview" title="Message preview">
              <p className="m-0 text-[13px] text-grey-600">{RULE_NAMES[previewKind]}, with sample details.</p>
              <MessagePreview template={previewRule.template} values={samples(previewKind)} channel={previewChannel(previewRule)} senderName={admin.garage.name} />
              <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-[13px] text-grey-700">
                {previewNotes(previewKind).map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
              {canEdit ? <TestSendForm kind={previewKind} /> : null}
            </Panel>
          )}
        </aside>
      </div>
    </div>
  );
}
