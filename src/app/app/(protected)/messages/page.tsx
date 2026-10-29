import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight, MessageSquare } from "lucide-react";
import { Badge, ChannelBadge, CountBadge, EmptyState, focusRing, PageHeader, Panel } from "@/components/admin-ui";
import { DEFAULT_TIME_ZONE, localDateKey } from "@/lib/admin/dates";
import { countMissedCallsNeedingOk } from "@/lib/calls/missed-calls";
import { loadInbox } from "@/lib/messages/inbox";
import { shortWhen } from "@/lib/messages/view";
import { getAdminContext } from "@/lib/tenancy/admin";
import { cn } from "@/lib/utils";
import { MESSAGES_DESCRIPTION, MessagesTabs } from "./_components/messages-tabs";

export const metadata: Metadata = { title: "Messages & calls" };

/** Messages & calls · Messages: one conversation per customer, newest first, with unread counts. */
export default async function MessagesPage() {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  const timeZone = admin.garage.timezone || DEFAULT_TIME_ZONE;
  const today = localDateKey(new Date(), timeZone);
  const [inbox, missed] = await Promise.all([loadInbox(admin.client, admin.garage.id), countMissedCallsNeedingOk(admin.client, admin.garage.id)]);

  return (
    <div className="flex flex-col gap-5 pb-10">
      <PageHeader title="Messages & calls" description={MESSAGES_DESCRIPTION} />
      <MessagesTabs current="messages" unread={inbox?.unreadTotal ?? 0} missed={missed} />

      {inbox === null ? (
        <div role="alert" className="rounded-card border border-[#f3c4c4] bg-[#fdecec] px-4 py-3.5 text-[14px] font-semibold text-[#991b1b]">
          Messages could not be loaded. Refresh the page to try again.
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-[18px]">
          <Panel title="Conversations" padding="flush" className="min-w-0 flex-[999_1_560px] gap-1" count={inbox.unreadTotal} countLabel={`${inbox.unreadTotal} unread`}>
            {inbox.conversations.length > 0 ? (
              <ul className="m-0 flex list-none flex-col p-0">
                {inbox.conversations.map((conversation) => (
                  <li key={conversation.customerId} className="border-t border-[#f1f5f9] first:border-t-0">
                    <Link
                      href={`/app/messages/${conversation.customerId}`}
                      className={cn("flex min-h-[64px] items-center gap-3 rounded-input py-3 text-inherit no-underline hover:bg-grey-50", focusRing)}
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                          <span className={cn("truncate text-[15px] text-navy-950", conversation.unread > 0 ? "font-bold" : "font-semibold")}>{conversation.name}</span>
                          <ChannelBadge channel={conversation.channel} />
                          {conversation.optedOut ? (
                            <Badge tone="muted" size="sm">
                              Opted out
                            </Badge>
                          ) : null}
                        </span>
                        <span className={cn("line-clamp-2 text-[14px] leading-snug break-words", conversation.unread > 0 ? "text-grey-800" : "text-grey-600")}>{conversation.preview}</span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1.5">
                        <time dateTime={conversation.at} className="text-[12.5px] text-grey-600 tabular-nums">
                          {shortWhen(conversation.at, { timeZone, today })}
                        </time>
                        <CountBadge count={conversation.unread} label={`${conversation.unread} unread`} />
                      </span>
                      <ChevronRight size={18} strokeWidth={2} aria-hidden="true" className="shrink-0 text-grey-500" />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                icon={MessageSquare}
                title="No messages yet"
                description="Replies to your reminders and booking texts, and messages customers send your garage's number, show up here."
              />
            )}
          </Panel>

          {inbox.unknown.length > 0 ? (
            <Panel title="From numbers we don't know" className="min-w-0 flex-[1_1_300px] gap-2.5">
              <p className="m-0 text-[13px] leading-snug text-grey-600">
                Texts from numbers that aren&apos;t one of your customers. Add them as a customer to reply.
              </p>
              <ul className="m-0 flex list-none flex-col p-0">
                {inbox.unknown.map((message) => (
                  <li key={message.id} className="flex flex-col gap-1 border-t border-[#f1f5f9] py-2.5 first:border-t-0 first:pt-0">
                    <span className="flex items-center justify-between gap-2 text-[13px]">
                      <strong className="font-semibold text-navy-950">{message.maskedNumber}</strong>
                      <time dateTime={message.at} className="text-grey-600 tabular-nums">
                        {shortWhen(message.at, { timeZone, today })}
                      </time>
                    </span>
                    <span className="line-clamp-3 text-[14px] leading-snug break-words text-grey-800">{message.preview}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </div>
      )}
    </div>
  );
}
