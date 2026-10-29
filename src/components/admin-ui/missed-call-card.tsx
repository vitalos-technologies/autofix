import { Bot, MessageSquareText, PhoneMissed } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "./badge";
import { formatTime } from "./format";
import { buttonClass } from "./styles";
import { SubmitButton } from "./submit-button";
import type { FormAction } from "./types";
import { VoicemailPlayer } from "./voicemail-player";

/** One unhandled missed call, as `listMissedCallsNeedingOk` (src/lib/calls/missed-calls.ts) returns it. */
export type MissedCallCardData = {
  id: string;
  /** ISO time the call came in. */
  at: string;
  callerName: string | null;
  /** `07••• •••123`, or null when the number was withheld. */
  maskedNumber: string | null;
  /** `tel:+44…`, or null when the number was withheld. */
  callBackHref: string | null;
  voicemailHref: string | null;
  voicemailSeconds: number | null;
  textedBack: boolean;
  /** What the AI front desk wrote about the call (P5.12 voice desk), or null when it didn't take it. */
  aiSummary?: string | null;
  /** booked, message, callback, answered, spam or dropped. */
  aiOutcome?: string | null;
};

const AI_OUTCOME_LABEL: Record<string, string> = {
  booked: "AI booked a request",
  message: "AI took a message",
  callback: "Wants a call back",
  answered: "AI answered",
  spam: "AI: spam",
  dropped: "Caller hung up",
};

export type MissedCallCardProps = {
  call: MissedCallCardData;
  timeZone: string;
  /** Posts `callId` (the form never names the garage). */
  markHandledAction: FormAction;
  /** `navy` on the phone's "Needs your OK" stack, `light` inside the desktop panel. */
  tone?: "light" | "navy";
  className?: string;
};

/**
 * "Needs your OK" card for a call nobody answered: who called (the customer's name when we know the
 * number, the number masked), when, whether they were texted back, the voicemail, "Call back" and
 * "Mark handled".
 */
export function MissedCallCard({ call, timeZone, markHandledAction, tone = "light", className }: MissedCallCardProps) {
  const navy = tone === "navy";
  const who = call.callerName ?? call.maskedNumber ?? "Withheld number";
  const titleId = `missed-call-${tone}-${call.id}`;
  return (
    <article
      aria-labelledby={titleId}
      className={cn("flex flex-col gap-2.5 font-sans leading-[normal]", navy ? "rounded-card bg-navy-950 p-3.5 text-white" : "text-grey-800", className)}
    >
      <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1">
        <PhoneMissed size={18} strokeWidth={2} aria-hidden="true" className={navy ? "text-[#f6d55c]" : "text-grey-700"} />
        <span className={cn("text-[12px] font-bold tracking-[0.06em] uppercase", navy ? "text-[#f6d55c]" : "text-grey-700")}>Missed call</span>
        <span className={cn("text-[12px]", navy ? "text-[#b8c4d4]" : "text-grey-600")}>· {formatTime(call.at, timeZone)}</span>
        {call.textedBack ? (
          <Badge tone="success" size="sm" className="gap-1 font-bold whitespace-nowrap">
            <MessageSquareText size={14} strokeWidth={2.2} aria-hidden="true" />
            Texted back
          </Badge>
        ) : null}
      </p>
      <p id={titleId} className="m-0 text-[14px]">
        <strong>{who}</strong>
        {call.callerName && call.maskedNumber ? <span className={navy ? "text-[#d7dee8]" : "text-grey-700"}> · {call.maskedNumber}</span> : null}
      </p>
      {call.aiSummary ? (
        <div className={cn("flex flex-col gap-1 rounded-[10px] p-2.5 text-[14px]", navy ? "bg-white/10 text-white" : "bg-grey-50 text-grey-800")}>
          <p className={cn("m-0 flex items-center gap-1.5 text-[12px] font-bold", navy ? "text-[#d7dee8]" : "text-grey-700")}>
            <Bot size={14} strokeWidth={2.2} aria-hidden="true" />
            {AI_OUTCOME_LABEL[call.aiOutcome ?? ""] ?? "AI front desk"}
          </p>
          <p className="m-0 leading-snug break-words">{call.aiSummary}</p>
        </div>
      ) : null}
      {call.voicemailHref ? <VoicemailPlayer href={call.voicemailHref} seconds={call.voicemailSeconds} tone={tone} /> : null}
      <div className="flex flex-wrap gap-2">
        {call.callBackHref ? (
          <a href={call.callBackHref} aria-label={`Call back ${who}`} className={buttonClass(navy ? "onDarkPrimary" : "primary", "sm", "flex-[1_1_auto] rounded-[11px] text-[14px] whitespace-nowrap")}>
            Call back
          </a>
        ) : null}
        <form action={markHandledAction} className="flex flex-[1_1_auto]">
          <input type="hidden" name="callId" value={call.id} />
          <SubmitButton aria-label={`Mark handled: call from ${who}`} className={buttonClass(navy ? "onDark" : "secondary", "sm", "w-full rounded-[11px] text-[14px] whitespace-nowrap")}>
            Mark handled
          </SubmitButton>
        </form>
      </div>
    </article>
  );
}
