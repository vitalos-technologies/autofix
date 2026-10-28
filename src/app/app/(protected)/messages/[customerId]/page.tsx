import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, Info, Phone, UserRound } from "lucide-react";
import { Badge, buttonClass, ChannelBadge, PageHeader, Panel, textLinkClass } from "@/components/admin-ui";
import { DEFAULT_TIME_ZONE, localDateKey } from "@/lib/admin/dates";
import { countMissedCallsNeedingOk } from "@/lib/calls/missed-calls";
import { countUnreadMessages, hasMessagingNumber, loadThread, THREAD_LIMIT } from "@/lib/messages/inbox";
import { canReply, REPLY_MAX_LENGTH } from "@/lib/messages/reply";
import { CHANNEL_NAMES, maskedAddress, replyBlock, threadItems, type ThreadItem } from "@/lib/messages/view";
import { getMessagingMode } from "@/lib/messaging/config";
import { telHref } from "@/lib/tenancy/contact";
import { getAdminContext } from "@/lib/tenancy/admin";
import { cn } from "@/lib/utils";
import { MessagesTabs } from "../_components/messages-tabs";
import { MarkThreadRead } from "./mark-read";
import { NewMark, ThreadNewMarks } from "./new-marks";
import { ReplyForm } from "./reply-form";

export const metadata: Metadata = { title: "Conversation" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PageProps = { params: Promise<{ customerId: string }> };

function time(at: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at));
}

const STATUS_TONES = { neutral: "text-[#b8c4d4]", success: "text-[#8ff0b0]", danger: "text-[#fca5a5]" } as const;

function Item({ item, name, timeZone }: { item: ThreadItem; name: string; timeZone: string }) {
  if (item.type === "day") {
    return (
      <li className="flex justify-center py-1">
        <span className="rounded-full bg-grey-100 px-3 py-1 text-[12px] font-semibold text-grey-700">{item.label}</span>
      </li>
    );
  }
  if (item.type === "system") {
    return (
      <li className="flex justify-center px-2 py-1">
        <p className="m-0 flex max-w-[520px] items-start gap-1.5 text-center text-[13px] leading-snug text-grey-700">
          <Info size={16} strokeWidth={2} aria-hidden="true" className="mt-px shrink-0" />
          <span>{item.text}</span>
        </p>
      </li>
    );
  }
  const outbound = item.direction === "outbound";
  return (
    <li className={cn("flex flex-col gap-1", outbound ? "items-end" : "items-start")}>
      <div
        className={cn(
          "flex max-w-[min(520px,88%)] flex-col gap-1.5 px-3.5 py-2.5 text-[14px] leading-[1.45] break-words",
          outbound ? "rounded-[16px_16px_4px_16px] bg-navy-950 text-white" : "rounded-[16px_16px_16px_4px] bg-grey-100 text-grey-800",
        )}
      >
        <span className="sr-only">{outbound ? "Garage:" : `${name}:`}</span>
        {item.label ? <span className={cn("text-[12px] font-bold tracking-[0.04em] uppercase", outbound ? "text-[#f6d55c]" : "text-grey-700")}>{item.label}</span> : null}
        <span className={cn("whitespace-pre-line", item.removed && "italic opacity-90")}>{item.text}</span>
        <span className={cn("flex flex-wrap items-center gap-x-1.5 text-[12px]", outbound ? "text-[#d7dee8]" : "text-grey-600")}>
          <time dateTime={item.at}>{time(item.at, timeZone)}</time>
          <span aria-hidden="true">·</span>
          <span>{CHANNEL_NAMES[item.channel]}</span>
          {item.status ? (
            <>
              <span aria-hidden="true">·</span>
              <span className={cn("font-semibold", STATUS_TONES[item.status.tone])}>{item.status.label}</span>
            </>
          ) : null}
        </span>
      </div>
      <NewMark itemKey={item.key} />
    </li>
  );
}

/** Messages & calls · one customer's conversation, oldest first, with the reply box. */
export default async function ConversationPage({ params }: PageProps) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  const { customerId } = await params;
  if (!UUID.test(customerId)) notFound();
  const timeZone = admin.garage.timezone || DEFAULT_TIME_ZONE;
  const today = localDateKey(new Date(), timeZone);
  const [thread, numberReady, unreadTotal, missed] = await Promise.all([
    loadThread(admin.client, admin.garage.id, customerId),
    hasMessagingNumber(admin.client, admin.garage.id),
    countUnreadMessages(admin.client, admin.garage.id),
    countMissedCallsNeedingOk(admin.client, admin.garage.id),
  ]);
  if (!thread || thread.customer.anonymised_at) notFound();

  const { customer, rows } = thread;
  const name = customer.name?.trim() || "Customer";
  const firstName = name.split(/\s+/)[0] ?? name;
  const channel = customer.channel === "email" || customer.channel === "whatsapp" ? customer.channel : "sms";
  const items = threadItems(rows, { timeZone, today });
  const unread = rows.filter((row) => row.direction === "inbound" && !row.read_at).length;
  const unreadKeys = items.flatMap((item) => (item.type === "message" && item.unread ? [item.key] : []));
  const blocked = replyBlock({ customer, canReply: canReply(admin.role), hasMessagingNumber: numberReady || channel === "email" });
  const address = maskedAddress(customer);
  const tel = customer.phone ? telHref(customer.phone) : null;

  return (
    <div className="flex flex-col gap-5 pb-10">
      <Link href="/app/messages" className={cn(textLinkClass, "-mb-2 hidden gap-1.5 self-start text-[14px] lg:inline-flex")}>
        <ArrowLeft size={18} strokeWidth={2} aria-hidden="true" />
        All messages
      </Link>
      <PageHeader
        eyebrow="Messages & calls"
        title={name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <ChannelBadge channel={channel} />
            {address ? <span>{address}</span> : null}
            {customer.opted_out_at ? (
              <Badge tone="muted" size="sm">
                Opted out
              </Badge>
            ) : null}
          </span>
        }
        actions={
          <div className="flex flex-wrap gap-2.5">
            {tel ? (
              <a href={tel} aria-label={`Call ${name}`} className={buttonClass("secondary")}>
                <Phone size={18} strokeWidth={2} aria-hidden="true" />
                Call
              </a>
            ) : null}
            <Link href={`/app/customers/${customer.id}`} className={buttonClass("secondary")}>
              <UserRound size={18} strokeWidth={2} aria-hidden="true" />
              Customer details
            </Link>
          </div>
        }
      />
      <MessagesTabs current="messages" unread={unreadTotal} missed={missed} />
      <MarkThreadRead customerId={customer.id} unread={unread} />

      <div className="flex max-w-[860px] flex-col gap-[18px]">
        <Panel title="Conversation" className="gap-3">
          {thread.truncated ? <p className="m-0 text-[13px] text-grey-600">Showing the latest {THREAD_LIMIT} messages.</p> : null}
          {items.length > 0 ? (
            <ThreadNewMarks unreadKeys={unreadKeys}>
              <ol aria-label="Messages, oldest first" className="m-0 flex list-none flex-col gap-2.5 p-0">
                {items.map((item) => (
                  <Item key={item.key} item={item} name={firstName} timeZone={timeZone} />
                ))}
              </ol>
            </ThreadNewMarks>
          ) : (
            <p className="m-0 text-[14px] text-grey-600">No messages with {firstName} yet.</p>
          )}
        </Panel>
        <Panel title="Reply" headingLevel={2}>
          <ReplyForm customerId={customer.id} firstName={firstName} channel={channel} blocked={blocked} mock={getMessagingMode() === "mock"} maxLength={REPLY_MAX_LENGTH} />
        </Panel>
      </div>
    </div>
  );
}
