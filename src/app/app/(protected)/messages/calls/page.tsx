import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CircleCheck, MessageSquareText, Phone, PhoneMissed } from "lucide-react";
import { Badge, buttonClass, EmptyState, PageHeader, Panel, SubmitButton, VoicemailPlayer } from "@/components/admin-ui";
import { DEFAULT_TIME_ZONE, localDateKey } from "@/lib/admin/dates";
import { countMissedCallsNeedingOk } from "@/lib/calls/missed-calls";
import { listRecentCalls, type RecentCall } from "@/lib/calls/recent-calls";
import { countUnreadMessages } from "@/lib/messages/inbox";
import { shortWhen } from "@/lib/messages/view";
import { getAdminContext } from "@/lib/tenancy/admin";
import { MESSAGES_DESCRIPTION, MessagesTabs } from "../_components/messages-tabs";
import { markCallHandledAction } from "../actions";

export const metadata: Metadata = { title: "Calls" };

function minutes(seconds: number) {
  if (seconds < 60) return `${seconds} s`;
  const whole = Math.round(seconds / 60);
  return `${whole} min`;
}

function CallItem({ call, timeZone, today }: { call: RecentCall; timeZone: string; today: string }) {
  const who = call.callerName ?? call.maskedNumber ?? "Withheld number";
  const titleId = `call-${call.id}`;
  const waiting = call.missed && !call.handled;
  return (
    <article aria-labelledby={titleId} className="flex flex-col gap-2.5 py-3.5 font-sans leading-[normal]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        {call.missed ? (
          <PhoneMissed size={18} strokeWidth={2} aria-hidden="true" className="text-[#b45309]" />
        ) : (
          <Phone size={18} strokeWidth={2} aria-hidden="true" className="text-success-ink" />
        )}
        <Badge tone={call.missed ? "warning" : "success"} size="sm" className="font-bold">
          {call.missed ? "Missed" : "Answered"}
        </Badge>
        <time dateTime={call.at} className="text-[13px] text-grey-600 tabular-nums">
          {shortWhen(call.at, { timeZone, today })}
          {localDateKey(call.at, timeZone) === today ? "" : `, ${new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(call.at))}`}
        </time>
        {call.durationSeconds ? <span className="text-[13px] text-grey-600">· {minutes(call.durationSeconds)}</span> : null}
        {call.textedBack ? (
          <Badge tone="success" size="sm" className="gap-1 font-bold whitespace-nowrap">
            <MessageSquareText size={14} strokeWidth={2.2} aria-hidden="true" />
            Texted back
          </Badge>
        ) : null}
      </div>
      <p id={titleId} className="m-0 text-[15px] text-grey-800">
        <strong className="text-navy-950">{who}</strong>
        {call.callerName && call.maskedNumber ? <span className="text-grey-700"> · {call.maskedNumber}</span> : null}
      </p>
      {call.voicemailHref ? <VoicemailPlayer href={call.voicemailHref} seconds={call.voicemailSeconds} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        {call.callBackHref ? (
          <a href={call.callBackHref} aria-label={`Call back ${who}`} className={buttonClass(waiting ? "primary" : "secondary", "sm", "rounded-[11px] text-[14px] whitespace-nowrap")}>
            Call back
          </a>
        ) : null}
        {waiting ? (
          <form action={markCallHandledAction} className="flex">
            <input type="hidden" name="callId" value={call.id} />
            <SubmitButton aria-label={`Mark handled: call from ${who}`} className={buttonClass("secondary", "sm", "rounded-[11px] text-[14px] whitespace-nowrap")}>
              Mark handled
            </SubmitButton>
          </form>
        ) : call.missed ? (
          <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-success-ink">
            <CircleCheck size={16} strokeWidth={2.2} aria-hidden="true" />
            Handled
          </span>
        ) : null}
      </div>
    </article>
  );
}

/** Messages & calls · Calls: the garage's latest calls, answered and missed, with voicemail and Mark handled. */
export default async function CallsPage() {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  const timeZone = admin.garage.timezone || DEFAULT_TIME_ZONE;
  const today = localDateKey(new Date(), timeZone);
  const [calls, missed, unread] = await Promise.all([
    listRecentCalls(admin.client, admin.garage.id),
    countMissedCallsNeedingOk(admin.client, admin.garage.id),
    countUnreadMessages(admin.client, admin.garage.id),
  ]);

  return (
    <div className="flex flex-col gap-5 pb-10">
      <PageHeader title="Messages & calls" description={MESSAGES_DESCRIPTION} />
      <MessagesTabs current="calls" unread={unread} missed={missed} />
      {calls === null ? (
        <div role="alert" className="rounded-card border border-[#f3c4c4] bg-[#fdecec] px-4 py-3.5 text-[14px] font-semibold text-[#991b1b]">
          Calls could not be loaded. Refresh the page to try again.
        </div>
      ) : (
        <Panel title="Recent calls" padding="flush" className="min-w-0 max-w-[860px] gap-1" count={missed} countLabel={`${missed} missed ${missed === 1 ? "call" : "calls"} to deal with`}>
          {calls.length > 0 ? (
            <ul className="m-0 flex list-none flex-col p-0">
              {calls.map((call) => (
                <li key={call.id} className="border-t border-[#f1f5f9] first:border-t-0">
                  <CallItem call={call} timeZone={timeZone} today={today} />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={Phone}
              title="No calls yet"
              description="Calls to your garage's number show up here once it is set up, with the voicemail and whether the caller was texted back."
            />
          )}
        </Panel>
      )}
    </div>
  );
}
