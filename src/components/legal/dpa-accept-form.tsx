"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { acceptDpaAction } from "@/lib/legal/agreement-actions";
import { initialAcceptAgreementState, type AcceptAgreementState } from "@/lib/legal/agreement-forms";

const messages: Partial<Record<AcceptAgreementState["status"], string>> = {
  unconfirmed: "Tick the box to confirm you accept the agreement.",
  forbidden: "Only a garage owner can accept this agreement.",
  stale: "The agreement has changed since this page loaded. Reload the page and read the new version.",
  failed: "The acceptance could not be saved. Try again.",
};

type DpaAcceptFormProps = {
  version: string;
  /** The garage's legal name, as filled into the agreement. */
  legalName: string;
};

/** Owner confirms and accepts the current DPA version (server checks role, version and hash). */
export function DpaAcceptForm({ version, legalName }: DpaAcceptFormProps) {
  const [state, formAction, pending] = useActionState<AcceptAgreementState, FormData>(acceptDpaAction, initialAcceptAgreementState);
  const [confirmed, setConfirmed] = useState(false);
  const messageRef = useRef<HTMLParagraphElement>(null);
  const handledSeq = useRef(state.seq);

  useEffect(() => {
    if (state.seq === handledSeq.current) return;
    handledSeq.current = state.seq;
    messageRef.current?.focus();
  }, [state]);

  const message = messages[state.status];
  return (
    <form action={formAction} className="mt-5 grid gap-4 rounded-2xl border border-[#CBD5E1] bg-white p-5">
      <input type="hidden" name="version" value={version} />
      <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-6 text-[#1E293B]">
        <input
          type="checkbox"
          name="confirm"
          value="yes"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          className="mt-1 size-5 shrink-0 cursor-pointer accent-[#2563EB]"
        />
        <span>
          I have read this Data Processing Agreement (version {version}) and accept it on behalf of {legalName}, as its owner.
        </span>
      </label>
      {message ? (
        <p ref={messageRef} tabIndex={-1} role="alert" className="m-0 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm font-bold text-amber-900 outline-none">
          {message}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="min-h-11 w-fit rounded-xl bg-[#0f2747] px-5 py-2.5 text-sm font-bold text-white hover:bg-[#16325A] focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] disabled:cursor-wait disabled:opacity-70"
      >
        {pending ? "Saving…" : "Accept agreement"}
      </button>
    </form>
  );
}
