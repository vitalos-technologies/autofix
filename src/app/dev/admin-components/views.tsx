import Link from "next/link";
import { CalendarPlus, Inbox, Plus, QrCode } from "lucide-react";
import { PlateChip } from "@/components/book";
import {
  AdminNavGroups,
  AdminTabBar,
  ApprovalCard,
  AutomationRow,
  Badge,
  buttonClass,
  ChannelBadge,
  CopyButton,
  DataTable,
  DiaryGrid,
  DnsRecordTable,
  DomainStatusSteps,
  EmbedSnippet,
  EmptyState,
  GarageSwitcher,
  JobCard,
  KpiCard,
  KpiGrid,
  MessagePreview,
  PageHeader,
  Panel,
  StatusPill,
  StepNumber,
  SummaryChips,
  TemplateEditor,
  textLinkClass,
  type AdminNavGroup,
  type StatusPillStatus,
} from "@/components/admin-ui";
import { bookingStatuses } from "@/lib/booking-engine/types";
import { cn } from "@/lib/utils";
import { galleryNoopAction } from "./actions";
import { AutomationsDemo, BrandingDemo, SwitchDemo } from "./client-demos";
import {
  BOOKING_PAGE_URL,
  DIARY_BOOKINGS,
  DUE_REMINDERS,
  GALLERY_BASE,
  GARAGES,
  MOT_TEMPLATE,
  NOW,
  RESOURCES,
  TEMPLATE_SAMPLE,
  TIME_ZONE,
  TODAY,
  type DueReminder,
} from "./sample-data";

const STATES = `${GALLERY_BASE}?view=states`;
const twoColumns = "flex flex-wrap items-start gap-[18px]";
const mainColumn = "flex min-w-0 flex-[999_1_560px] flex-col gap-[18px]";
const sideColumn = "flex min-w-0 flex-[1_1_300px] flex-col gap-[18px]";

/* ------------------------------------------------------------------------------------------------
 * Today: Admin-Dashboard from 1024px, Admin-Today-Phone below.
 * ---------------------------------------------------------------------------------------------- */

export function TodayView() {
  const cars = DIARY_BOOKINGS.length - 1;
  const jobs = [
    { id: "d1", time: "2026-10-27T08:30:00Z", bay: "Bay 1", reg: "CD34EFG", model: "Astra", service: "Full service", status: "ready" as const },
    { id: "d2", time: "2026-10-27T10:00:00Z", bay: "Bay 1", reg: "AB12CDE", model: "Focus", service: "Diagnostics", detail: "warning light", status: "in_progress" as const, active: true },
    { id: "d5", time: "2026-10-27T09:30:00Z", bay: "Bay 2", reg: "JK18LMN", model: "Qashqai", service: "Clutch", detail: "parts due 12:00", status: "waiting_parts" as const },
    { id: "d7", time: "2026-10-27T11:00:00Z", bay: "Bay 3", reg: "NP20QRS", model: "Polo", service: "Diagnostics", status: "confirmed" as const },
  ];

  return (
    <div className="flex flex-col gap-3.5 lg:gap-[22px]">
      <PageHeader
        eyebrow="Tuesday 27 October"
        phoneEyebrow="Tue 27 Oct"
        title={`Morning, Dan. ${cars} cars in today.`}
        phoneTitle="Today"
        actions={
          <div className="hidden gap-2.5 lg:flex">
            <CopyButton value={BOOKING_PAGE_URL} label="Copy booking link" />
            <Link href={`${STATES}#job-cards`} className={buttonClass("primary", "md", "px-[18px]")}>
              <Plus size={18} strokeWidth={2.4} aria-hidden="true" />
              New booking
            </Link>
          </div>
        }
      >
        <div className="lg:hidden">
          <SummaryChips
            label="Today at a glance"
            chips={[
              { label: `${cars} cars`, tone: "navy" },
              { label: "2 to approve", tone: "neutral", href: "#needs-ok-phone" },
              { label: "1 waiting parts", tone: "warning" },
              { label: "3 ready", tone: "success" },
            ]}
          />
        </div>
      </PageHeader>

      {/* Phone (Admin-Today-Phone) */}
      <div className="flex flex-col gap-2.5 lg:hidden">
        <div id="needs-ok-phone">
          <ApprovalCard
            tone="navy"
            bookingId="bk-1"
            registration="AB12CDE"
            source="online"
            customerName="Sarah Okafor"
            vehicle="Ford Focus"
            service="Diagnostics"
            startsAt="2026-10-28T09:15:00Z"
            timeZone={TIME_ZONE}
            acceptAction={galleryNoopAction}
            secondary={{ action: galleryNoopAction }}
          />
        </div>
        <h2 className="sr-only">Cars today</h2>
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {jobs.map((job) => (
            <li key={job.id}>
              <JobCard
                bookingId={job.id}
                startsAt={job.time}
                timeZone={TIME_ZONE}
                resourceName={job.bay}
                registration={job.reg}
                vehicle={job.model}
                service={job.service}
                detail={job.detail}
                status={job.status}
                href={`${STATES}#job-cards`}
                active={job.active}
                actions={[
                  { label: "Add photos", href: `${STATES}#job-cards` },
                  { label: "Send quote", href: `${STATES}#job-cards` },
                  { label: "Mark ready", action: galleryNoopAction, fields: { status: "ready" }, variant: "success" },
                ]}
              />
            </li>
          ))}
        </ul>
      </div>

      {/* Desktop (Admin-Dashboard) */}
      <div className="hidden flex-col gap-[22px] lg:flex">
        <KpiGrid label="This week">
          <KpiCard label="Bookings this week" value="23" trend={{ label: "6 more than last week" }} />
          <KpiCard label="Booked online" value="71%" context="8 booked outside opening hours" />
          <KpiCard label="Won back by reminders" value="£1,940" trend={{ label: "38 bookings this month" }} tone="navy" />
          <KpiCard label="Missed calls caught" value="9" context="7 booked after the text-back" />
        </KpiGrid>

        <div className={twoColumns}>
          <DiaryGrid
            className="min-w-0 flex-[999_1_560px]"
            resources={RESOURCES}
            bookings={DIARY_BOOKINGS}
            date={TODAY}
            timeZone={TIME_ZONE}
            now={NOW}
          />
          <div className={sideColumn}>
            <Panel id="needs-ok" title="Needs your OK" count={2} countLabel="2 bookings waiting">
              <ul className="m-0 flex list-none flex-col p-0">
                <li className="border-b border-[#eef2f6] pb-3.5">
                  <ApprovalCard
                    bookingId="bk-1"
                    registration="AB12CDE"
                    source="online"
                    receivedAt="2026-10-26T21:40:00Z"
                    now={NOW}
                    customerName="Sarah Okafor"
                    service="Diagnostics"
                    startsAt="2026-10-28T09:15:00Z"
                    timeZone={TIME_ZONE}
                    acceptAction={galleryNoopAction}
                    secondary={{ action: galleryNoopAction }}
                  />
                </li>
                <li className="pt-3.5">
                  <ApprovalCard
                    bookingId="bk-2"
                    registration="WX15YZA"
                    source="missed_call"
                    receivedAt="2026-10-27T08:12:00Z"
                    now={NOW}
                    customerName="James P."
                    service="Mobile visit, DN5"
                    detail="Won't start"
                    timeZone={TIME_ZONE}
                    acceptAction={galleryNoopAction}
                    secondary={{ href: "tel:+441302000000" }}
                  />
                </li>
              </ul>
            </Panel>
            <Panel title="Reminders this week" className="gap-3">
              <dl className="m-0 grid grid-cols-3 gap-2 text-center">
                {[
                  { label: "Due", value: "42", tone: "plain" },
                  { label: "Sent", value: "18", tone: "plain" },
                  { label: "Booked", value: "9", tone: "success" },
                ].map((item) => (
                  <div key={item.label} className={cn("flex flex-col-reverse gap-0.5 rounded-input px-1 py-2.5", item.tone === "success" ? "bg-success-bg" : "bg-grey-50")}>
                    <dt className={cn("text-[12px]", item.tone === "success" ? "text-success-ink" : "text-grey-600")}>{item.label}</dt>
                    <dd className={cn("m-0 font-display text-[26px] font-bold", item.tone === "success" ? "text-success-ink" : "text-navy-950")}>{item.value}</dd>
                  </div>
                ))}
              </dl>
              <Link href={`${GALLERY_BASE}?view=reminders`} className={cn(textLinkClass, "self-start text-[14px]")}>
                Open reminders →
              </Link>
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Reminders (Admin-Reminders)
 * ---------------------------------------------------------------------------------------------- */

function dueColumns() {
  return [
    { key: "customer", header: "Customer", rowHeader: true, cell: (row: DueReminder) => row.customer },
    { key: "car", header: "Car", cell: (row: DueReminder) => <PlateChip registration={row.registration} className="rounded-[4px] px-1.5 py-px text-[14px]" /> },
    { key: "due", header: "Due", cell: (row: DueReminder) => row.due },
    { key: "type", header: "Type", cell: (row: DueReminder) => row.type },
    { key: "status", header: "Status", cell: (row: DueReminder) => <StatusPill status={row.status} label={row.label} size="sm" /> },
  ];
}

export function RemindersView() {
  return (
    <div className="flex flex-col gap-[22px]">
      <PageHeader
        title="Reminders"
        description="Automatic texts that bring customers back. They only go to people who opted in, and every message has a one-tap opt-out."
        actions={
          <Link href={`${STATES}#data-table`} className={buttonClass("secondary")}>
            Import customer list
          </Link>
        }
      />
      <KpiGrid label="This month">
        <KpiCard size="sm" label="Sent this month" value="142" />
        <KpiCard size="sm" label="Booked from a reminder" value="38" secondaryValue="27%" />
        <KpiCard size="sm" label="Revenue won back" value="£1,940" tone="navy" />
        <KpiCard size="sm" label="Opted out" value="3" />
      </KpiGrid>
      <div className={twoColumns}>
        <div className={cn(mainColumn, "flex-[999_1_520px]")}>
          <Panel title="Automations" padding="flush" className="gap-1">
            <AutomationsDemo editHref={`${STATES}#template-editor`} />
          </Panel>
          <Panel title="Due in the next 30 days" className="gap-2.5">
            <DataTable
              caption="Reminders due in the next 30 days"
              columns={dueColumns()}
              rows={DUE_REMINDERS}
              getRowKey={(row) => row.id}
              isRowMuted={(row) => row.status === "no_consent"}
            />
          </Panel>
        </div>
        <aside aria-label="Message preview" className={sideColumn}>
          <Panel title="Message preview">
            <MessagePreview template={MOT_TEMPLATE} values={TEMPLATE_SAMPLE} senderName="HartleyRd" />
            <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-[13px] text-grey-700">
              <li>Link opens the booking page with the car already filled in.</li>
              <li>Sends 09:00–19:00 only, never on Sundays.</li>
              <li>Uses the garage&apos;s sender name.</li>
            </ul>
            <form action={galleryNoopAction} className="flex">
              <button type="submit" className={buttonClass("secondary", "md", "w-full")}>
                Send me a test
              </button>
            </form>
          </Panel>
        </aside>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Booking page & domain (Admin-Domain)
 * ---------------------------------------------------------------------------------------------- */

const FREE_LINK = "hartley-road.pitline.co.uk";
const CUSTOM_HOST = "book.hartleyroadmotors.co.uk";
const DNS_STEPS_EMAIL = `mailto:?subject=${encodeURIComponent("Please add this DNS record")}&body=${encodeURIComponent(
  `Please add this record to the DNS for hartleyroadmotors.co.uk:\n\nType: CNAME\nName: book\nValue: cname.vercel-dns-0.com\n\nThanks!`,
)}`;

export function DomainView() {
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Booking page" description="Where customers book. Use our free link today, then move it to your own web address." />
      <div className={twoColumns}>
        <div className={mainColumn}>
          <Panel id="free-link" title="Your free link" leading={<StepNumber step={1} state="done" />} actions={<Badge tone="success" size="sm" className="font-bold">Live</Badge>} className="gap-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <code className="min-w-0 flex-[1_1_300px] rounded-[10px] border border-grey-200 bg-grey-50 px-3.5 py-3 font-mono text-[14px] font-medium break-all text-navy-950">
                {FREE_LINK}
              </code>
              <CopyButton value={`https://${FREE_LINK}`} srSuffix="free booking link" />
              <button type="button" className={buttonClass("secondary")}>
                <QrCode size={18} strokeWidth={2} aria-hidden="true" />
                Show QR code
              </button>
            </div>
          </Panel>

          <Panel id="own-address" title="Use your own address" leading={<StepNumber step={2} state="current" />} highlight>
            <form action={galleryNoopAction} className="flex flex-wrap items-end gap-2.5">
              <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-1.5">
                <label htmlFor="domain" className="text-[14px] font-semibold text-grey-800">
                  Web address
                </label>
                <input
                  id="domain"
                  name="hostname"
                  defaultValue={CUSTOM_HOST}
                  autoComplete="off"
                  inputMode="url"
                  className="h-[46px] rounded-input border border-grey-300 px-3.5 text-[15px] text-navy-950 focus-visible:border-2 focus-visible:border-accent focus-visible:outline-none"
                />
              </div>
              <button type="submit" className={buttonClass("primary", "md", "min-h-[46px] px-[18px]")}>
                Connect
              </button>
            </form>
            <p className="m-0 text-[14px] leading-normal text-grey-700">Add this one record where your domain is managed (GoDaddy, 123 Reg, IONOS, Cloudflare…):</p>
            <DnsRecordTable records={[{ type: "CNAME", name: "book", value: "cname.vercel-dns-0.com" }]} caption={`DNS record for ${CUSTOM_HOST}`} />
            <DomainStatusSteps status="verifying" hostname={CUSTOM_HOST} />
            <a href={DNS_STEPS_EMAIL} className={cn(textLinkClass, "self-start text-[14px]")}>
              Not sure how? Email these steps to whoever looks after your website
            </a>
          </Panel>

          <Panel id="add-to-website" title="Add it to your website" leading={<StepNumber step={3} state="upcoming" />}>
            <EmbedSnippet bookingUrl={`https://${CUSTOM_HOST}`} accent="#155fba" garageName="Hartley Road Motors" />
          </Panel>
        </div>
        <aside aria-label="Your branding" className={sideColumn}>
          <Panel title="Your branding" className="gap-4">
            <BrandingDemo garageName="Hartley Road Motors" initials="HR" />
          </Panel>
        </aside>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------
 * More (phone "More" tab; new screen, not in the canvas yet)
 * ---------------------------------------------------------------------------------------------- */

export function MoreView({ nav, activeHref }: { nav: AdminNavGroup[]; activeHref: string }) {
  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader title="More" />
      <GarageSwitcher garages={GARAGES} currentGarageId="g-hartley" switchGarageAction={galleryNoopAction} tone="light" />
      <nav aria-label="All sections">
        <AdminNavGroups groups={nav} activeHref={activeHref} tone="light" />
      </nav>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------
 * States: every component and its variants.
 * ---------------------------------------------------------------------------------------------- */

const REMINDER_STATES: StatusPillStatus[] = ["scheduled", "sending", "sent", "delivered", "failed", "cancelled", "skipped", "booked", "no_consent"];

export function StatesView() {
  return (
    <div className="flex flex-col gap-[22px]">
      <PageHeader
        eyebrow="Dev gallery"
        title="Admin components"
        description={
          <>
            Every component in <code className="font-mono text-[14px]">src/components/admin-ui</code> with sample data and state variants. Not indexed;
            404 in production.
          </>
        }
      />

      <Panel id="status-pills" title="StatusPill">
        <div className="flex flex-col gap-2">
          <h3 className="m-0 font-sans text-[13px] font-semibold tracking-normal text-grey-600">Bookings</h3>
          <div className="flex flex-wrap gap-2">
            {bookingStatuses.map((status) => (
              <StatusPill key={status} status={status} />
            ))}
            <StatusPill status="waiting_parts" compact />
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="m-0 font-sans text-[13px] font-semibold tracking-normal text-grey-600">Reminder sends</h3>
          <div className="flex flex-wrap items-center gap-2">
            {REMINDER_STATES.map((status) => (
              <StatusPill key={status} status={status} size="sm" />
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="m-0 font-sans text-[13px] font-semibold tracking-normal text-grey-600">Badges</h3>
          <div className="flex flex-wrap items-center gap-2">
            <ChannelBadge channel="sms" />
            <ChannelBadge channel="whatsapp" />
            <ChannelBadge channel="email" />
            <ChannelBadge channel="customer" />
            <Badge tone="success" className="font-bold">Live</Badge>
            <Badge tone="navy" size="lg">9 cars</Badge>
          </div>
        </div>
      </Panel>

      <Panel id="kpis" title="KpiCard">
        <KpiGrid>
          <KpiCard label="Bookings this week" value="0" context="Nothing booked yet" />
          <KpiCard label="Booked online" value="12%" trend={{ label: "4 fewer than last week", tone: "negative" }} />
          <KpiCard label="Won back by reminders" value="£0" context="No reminder bookings yet" tone="navy" />
          <KpiCard size="sm" label="Booked from a reminder" value="38" secondaryValue="27%" />
        </KpiGrid>
      </Panel>

      <section id="diary" aria-label="DiaryGrid states" className="flex flex-col gap-[18px]">
        <DiaryGrid
          title="Sun 25 Oct 2026 (clocks go back at 02:00): 09:15 GMT sits at 09:15"
          resources={RESOURCES.slice(0, 2)}
          bookings={[
            {
              id: "cc1",
              resourceId: "bay-1",
              startsAt: "2026-10-25T09:15:00Z",
              endsAt: "2026-10-25T10:15:00Z",
              status: "requested",
              registration: "AB12CDE",
              service: "Diagnostics",
              vehicle: "Focus",
              href: `${STATES}#diary`,
            },
            {
              id: "cc2",
              resourceId: null,
              startsAt: "2026-10-25T13:00:00Z",
              endsAt: "2026-10-25T14:30:00Z",
              status: "collected",
              registration: "CD34EFG",
              service: "Full service",
              customerName: "Priya Shah",
              href: `${STATES}#diary`,
            },
            {
              id: "cc3",
              resourceId: "bay-2",
              startsAt: "2026-10-25T07:00:00Z",
              endsAt: "2026-10-25T09:00:00Z",
              status: "in_progress",
              registration: "JK18LMN",
              service: "Early drop-off",
              href: `${STATES}#diary`,
            },
          ]}
          date="2026-10-25"
          timeZone={TIME_ZONE}
          now="2026-10-25T10:20:00Z"
        />
        <DiaryGrid resources={RESOURCES} bookings={[]} date="2026-10-28" timeZone={TIME_ZONE} now={NOW} startHour={7} endHour={19} />
        <DiaryGrid title="No resources" resources={[]} bookings={[]} date={TODAY} timeZone={TIME_ZONE} />
      </section>

      <Panel id="job-cards" title="JobCard">
        <ul className="m-0 grid list-none grid-cols-1 gap-2.5 p-0 md:grid-cols-2">
          {(["requested", "confirmed", "arrived", "waiting_parts", "ready", "collected", "no_show"] as const).map((status, index) => (
            <li key={status}>
              <JobCard
                bookingId={`job-${status}`}
                startsAt={`2026-10-27T${String(8 + index).padStart(2, "0")}:30:00Z`}
                timeZone={TIME_ZONE}
                resourceName={index % 2 ? "Bay 2" : "Mobile van"}
                registration="NP20QRS"
                vehicle={index === 3 ? null : "Polo"}
                service={index === 3 ? "A much longer service name that has to truncate on a phone" : "Diagnostics"}
                status={status}
              />
            </li>
          ))}
          <li>
            <JobCard
              bookingId="job-active"
              startsAt="2026-10-27T10:00:00Z"
              timeZone={TIME_ZONE}
              resourceName="Bay 1"
              registration="AB12CDE"
              vehicle="Focus"
              service="Diagnostics"
              status="in_progress"
              active
              renderActions={() => (
                <div className="flex gap-1.5">
                  <Link href={`${STATES}#job-cards`} className={buttonClass("secondary", "sm", "flex-1")}>
                    Open booking
                  </Link>
                </div>
              )}
            />
          </li>
        </ul>
      </Panel>

      <Panel id="approvals" title="ApprovalCard" count={3}>
        <ul className="m-0 grid list-none grid-cols-1 gap-3.5 p-0 md:grid-cols-2">
          <li className="rounded-input border border-grey-200 p-3.5">
            <ApprovalCard
              bookingId="ap-ai"
              registration="KL19MNP"
              source="ai_agent"
              receivedAt="2026-10-25T10:00:00Z"
              now={NOW}
              customerName="Mark Evans"
              service="MOT"
              startsAt="2026-10-29T14:00:00Z"
              timeZone={TIME_ZONE}
              acceptAction={galleryNoopAction}
              secondary={{ action: galleryNoopAction }}
            />
          </li>
          <li className="rounded-input border border-grey-200 p-3.5">
            <ApprovalCard
              bookingId="ap-reminder"
              registration="BC23DEF"
              source="reminder"
              receivedLabel="just now"
              customerName="Priya Shah"
              service="MOT"
              startsAt="2026-10-30T09:00:00Z"
              timeZone={TIME_ZONE}
              acceptAction={galleryNoopAction}
              secondary={{ label: "Call back", href: "tel:+441302000001" }}
            />
          </li>
          <li>
            <ApprovalCard
              tone="navy"
              bookingId="ap-missed"
              registration="WX15YZA"
              source="missed_call"
              receivedAt="2026-10-27T08:12:00Z"
              now={NOW}
              customerName="James P."
              service="Mobile visit, DN5"
              detail="Won't start"
              acceptAction={galleryNoopAction}
              secondary={{ href: "tel:+441302000000" }}
            />
          </li>
        </ul>
      </Panel>

      <Panel id="automations" title="AutomationRow (form submit) and Switch" padding="flush" className="gap-1">
        <AutomationRow
          name="MOT due"
          description="Saved by a server action: the form posts ruleId and enabled"
          channel="customer"
          enabled
          ruleId="rule-mot"
          toggleAction={galleryNoopAction}
          editHref={`${STATES}#template-editor`}
        />
        <AutomationRow name="Review request" description="Off and disabled (no Google review link set)" channel="email" enabled={false} disabled />
        <div className="py-3">
          <SwitchDemo />
        </div>
      </Panel>

      <div className={twoColumns}>
        <Panel id="template-editor" title="TemplateEditor" className={mainColumn}>
          <TemplateEditor
            label="MOT reminder text"
            hint="Placeholders are filled in for each customer. The opt-out line is added for you."
            defaultValue={MOT_TEMPLATE}
            sampleValues={TEMPLATE_SAMPLE}
            senderName="HartleyRd"
          />
        </Panel>
        <Panel id="message-preview" title="MessagePreview" className={sideColumn}>
          <MessagePreview
            template={`Hi {first_name}, your {vehicle} is ready to collect. We’re open until 17:30. ${"Thanks again for choosing us. ".repeat(2)}{garage}`}
            values={TEMPLATE_SAMPLE}
            senderName="HartleyRd"
          />
          <MessagePreview template="Hi {first_name}, your {vehicle} ({reg}) is due on {due_date}: {link}" values={{ first_name: "Tom" }} channel="whatsapp" />
          <MessagePreview template="" values={TEMPLATE_SAMPLE} />
        </Panel>
      </div>

      <Panel id="domain-states" title="DnsRecordTable and DomainStatusSteps">
        <DnsRecordTable
          records={[
            { type: "CNAME", name: "book", value: "cname.vercel-dns-0.com" },
            { type: "TXT", name: "_vercel", value: "vc-domain-verify=book.hartleyroadmotors.co.uk,8a1f2c3d4e", ttl: "3600" },
          ]}
        />
        {(["pending_dns", "verifying", "active"] as const).map((status) => (
          <div key={status} className="flex flex-col gap-1.5">
            <h3 className="m-0 font-mono text-[13px] font-medium tracking-normal text-grey-600">{status}</h3>
            <DomainStatusSteps status={status} />
          </div>
        ))}
        <div className="flex flex-col gap-1.5">
          <h3 className="m-0 font-mono text-[13px] font-medium tracking-normal text-grey-600">failed</h3>
          <DomainStatusSteps status="failed" hostname={CUSTOM_HOST} error="The book record points to another server. Change it to cname.vercel-dns-0.com." />
        </div>
      </Panel>

      <Panel id="embed" title="EmbedSnippet (teal garage)">
        <EmbedSnippet bookingUrl="https://donvalley.pitline.co.uk" accent="#0f766e" garageName="Don Valley Autos" defaultKind="embed" />
      </Panel>

      <div className={twoColumns}>
        <Panel id="data-table" title="DataTable and EmptyState" className={mainColumn}>
          <DataTable
            caption="Customers"
            columns={dueColumns()}
            rows={[]}
            getRowKey={(row) => row.id}
            empty={
              <EmptyState
                icon={Inbox}
                title="No customers yet"
                description="Customers appear here after their first booking, or import a list from your old system."
                action={
                  <Link href={`${STATES}#data-table`} className={buttonClass("primary", "sm")}>
                    Import customer list
                  </Link>
                }
              />
            }
          />
          <EmptyState tone="card" icon={CalendarPlus} title="Nothing needs your OK" description="New online, missed-call and AI agent bookings that need approving show here." />
        </Panel>
        <Panel id="garage-switcher" title="GarageSwitcher and AdminTabBar" className={sideColumn}>
          <GarageSwitcher garages={GARAGES} currentGarageId="g-donvalley" switchGarageAction={galleryNoopAction} tone="light" />
          <GarageSwitcher garages={GARAGES.slice(0, 1)} currentGarageId="g-hartley" tone="light" />
          <AdminTabBar activeHref="/app/customers" fixed={false} label="Tab bar sample" className="rounded-input border" />
        </Panel>
      </div>
    </div>
  );
}
