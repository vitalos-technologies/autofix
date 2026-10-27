"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { buttonClass, SubmitButton } from "@/components/admin-ui";
import { smsSegments } from "@/lib/messaging/templates";
import { cn } from "@/lib/utils";
import { replyAction, type ReplyState } from "../actions";

const initial: ReplyState = { seq: 0, status: "idle" };

export type ReplyFormProps = {
  customerId: string;
  firstName: string;
  channel: "sms" | "whatsapp" | "email";
  /** Why replying is off, in plain words; the form is shown disabled with it. */
  blocked: string | null;
  /** Messaging is in mock mode: replies go to the test outbox. */
  mock: boolean;
  maxLength: number;
};

const CHANNEL_HINTS = {
  sms: "Sends as a text from your garage's number, so they can text back.",
  whatsapp: "Sends on WhatsApp from your garage's number.",
  email: "Sends as an email from your garage.",
} as const;

/** The reply box under a conversation: the customer's own channel, a live count for texts. */
export function ReplyForm({ customerId, firstName, channel, blocked, mock, maxLength }: ReplyFormProps) {
  const [state, formAction] = useActionState(replyAction, initial);
  const [text, setText] = useState("");
  const [clearedSeq, setClearedSeq] = useState(state.seq);
  const field = useRef<HTMLTextAreaElement>(null);
  const handled = useRef(state.seq);

  if (state.seq !== clearedSeq) {
    setClearedSeq(state.seq);
    if (state.status === "sent") setText("");
  }

  useEffect(() => {
    if (state.seq === handled.current) return;
    handled.current = state.seq;
    if (state.status === "error") field.current?.focus();
  }, [state]);

  const info = smsSegments(text);
  const count = channel === "sms" && text ? ` · ${info.segments} ${info.segments === 1 ? "text" : "texts"}` : "";
  const hintId = `reply-${customerId}-hint`;
  const countId = `reply-${customerId}-count`;
  const reasonId = `reply-${customerId}-reason`;
  const errorId = `reply-${customerId}-error`;

  return (
    <form action={formAction} className="flex flex-col gap-2.5" noValidate>
      <input type="hidden" name="customerId" value={customerId} />
      {blocked ? (
        <p id={reasonId} className="m-0 rounded-input bg-grey-100 px-3.5 py-3 text-[14px] leading-snug font-semibold text-grey-800">
          {blocked}
        </p>
      ) : null}
      <fieldset disabled={Boolean(blocked)} className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
        <legend className="sr-only">Reply</legend>
        <label htmlFor={`reply-${customerId}`} className="text-[14px] font-semibold text-grey-800">
          Reply to {firstName}
        </label>
        <p id={hintId} className="m-0 text-[13px] text-grey-600">
          {CHANNEL_HINTS[channel]}
          {mock ? " Messaging is in test mode: replies go to the test outbox." : ""}
        </p>
        <textarea
          ref={field}
          id={`reply-${customerId}`}
          name="body"
          rows={3}
          maxLength={maxLength}
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-describedby={[blocked ? reasonId : null, hintId, countId, state.fieldError ? errorId : null].filter(Boolean).join(" ")}
          aria-invalid={state.fieldError ? true : undefined}
          className={cn(
            "min-h-[96px] w-full resize-y rounded-input border bg-white px-3.5 py-3 font-sans text-[15px] leading-normal text-navy-950",
            "focus-visible:border-2 focus-visible:border-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-grey-50",
            state.fieldError ? "border-2 border-[#b91c1c]" : "border-grey-300",
          )}
        />
        <p id={countId} className="m-0 text-[13px] text-grey-600 tabular-nums">
          {text.length} of {maxLength} characters{count}
        </p>
        {state.fieldError ? (
          <p id={errorId} className="m-0 text-[13px] font-semibold text-[#b91c1c]">
            {state.fieldError}
          </p>
        ) : null}
        <div className="flex">
          <SubmitButton className={buttonClass("primary", "md", "min-h-[54px] w-full px-6 text-[16px] sm:w-auto")}>Send reply</SubmitButton>
        </div>
      </fieldset>
      <div role="status" className="text-[14px] font-semibold">
        {state.status === "sent" ? <p className="m-0 rounded-input bg-success-bg px-3.5 py-3 text-success-ink">{state.message}</p> : null}
      </div>
      {state.status === "error" && !state.fieldError ? (
        <p role="alert" className="m-0 rounded-input bg-[#fdecec] px-3.5 py-3 text-[14px] font-semibold text-[#991b1b]">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
