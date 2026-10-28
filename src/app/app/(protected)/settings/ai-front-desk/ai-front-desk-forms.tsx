"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import { buttonClass, CopyButton, SubmitButton } from "@/components/admin-ui";
import { initialIssueTokenState, TOKEN_NAME_MAX, type IssueTokenState } from "@/lib/ai-front-desk/forms";
import { FormMessage, TextInputField } from "../_components/fields";
import { issueWorkforceTokenAction } from "./actions";

/** Create a Workforce token: the raw token shows once, here, with a Copy button. */
export function IssueTokenForm({ canEdit }: { canEdit: boolean }) {
  const [state, formAction] = useActionState<IssueTokenState, FormData>(issueWorkforceTokenAction, initialIssueTokenState);
  const [name, setName] = useState("Workforce calls and WhatsApp");
  const handled = useRef(state.seq);
  useEffect(() => {
    if (state.seq === handled.current) return;
    handled.current = state.seq;
    if (state.fieldErrors?.name) document.getElementById("token-name")?.focus();
    else if (state.token) document.getElementById("new-token")?.focus();
  }, [state]);

  return (
    <div className="flex flex-col gap-3">
      <form action={formAction} noValidate className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-2.5">
          <TextInputField
            id="token-name"
            name="name"
            label="Token name"
            hint="So you can tell tokens apart later."
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={TOKEN_NAME_MAX}
            autoComplete="off"
            disabled={!canEdit}
            error={state.fieldErrors?.name}
            className="min-w-0 flex-[1_1_260px]"
          />
          <SubmitButton disabled={!canEdit} className={buttonClass("primary", "md", "w-full sm:w-auto")}>
            <KeyRound size={16} strokeWidth={2} aria-hidden="true" />
            Create token
          </SubmitButton>
        </div>
        <FormMessage state={state} />
      </form>
      {state.token ? (
        <div className="flex flex-col gap-2 rounded-input border border-grey-200 bg-grey-50 p-3.5">
          <p className="m-0 text-[14px] font-semibold text-navy-950">New token for {state.tokenName}</p>
          <code
            id="new-token"
            tabIndex={-1}
            className="rounded-input border border-grey-200 bg-white px-3 py-2.5 font-mono text-[13px] break-all text-navy-950"
          >
            {state.token}
          </code>
          <div className="flex flex-wrap items-center gap-2.5">
            <CopyButton value={state.token} label="Copy token" srSuffix={`token ${state.tokenName ?? ""}`} className="w-full sm:w-auto" />
            <p className="m-0 text-[13px] text-grey-700">Give it to Vitalos for Workforce. It is shown only now; if it is lost, revoke it and create another.</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
