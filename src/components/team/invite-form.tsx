"use client";

import { useActionState, useEffect, useRef } from "react";
import { CopyButton } from "@/components/admin-ui/copy-button";
import { buttonClass } from "@/components/admin-ui/styles";
import { Notice, TextField, inputClass } from "@/components/onboarding/field";
import { INVITE_ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/lib/signup/schema";
import { inviteStaffAction, type InviteFormState } from "@/lib/team/actions";

const initial: InviteFormState = { seq: 0, errors: {} };

/** Shows the link once, after an invite is sent or re-sent. */
export function InviteSentNotice({ sent }: { sent: NonNullable<InviteFormState["sent"]> }) {
  return (
    <div role="status" className="flex flex-col gap-2 rounded-[12px] border border-[#bfe5cb] bg-success-bg p-3.5 text-[14px] leading-5 text-success-ink">
      <p className="m-0 font-semibold">
        {sent.resent ? "Invite sent again" : "Invite sent"} to {sent.email} as {ROLE_LABELS[sent.role].toLowerCase()}.
        {sent.emailed ? "" : " The email could not be sent, so share the link yourself."}
      </p>
      <p className="m-0 text-grey-700">You can also send them this link. It works once, for 7 days, and is shown only now.</p>
      <div className="flex flex-wrap items-center gap-2">
        <code data-testid="invite-link" className="min-w-0 flex-1 rounded-lg bg-white p-2 font-mono text-[13px] break-all text-navy-950">{sent.link}</code>
        <CopyButton value={sent.link} label="Copy link" srSuffix="invite link" size="sm" icon />
      </div>
    </div>
  );
}

/** Invite by email with a role (manager, technician, front desk). */
export function InviteForm() {
  const [state, action, pending] = useActionState(inviteStaffAction, initial);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!state.seq) return;
    if (state.sent) formRef.current?.reset();
    formRef.current?.querySelector<HTMLElement>("[aria-invalid='true'], [data-form-message]")?.focus();
  }, [state]);

  return (
    <form ref={formRef} action={action} noValidate className="flex flex-col gap-4">
      <TextField id="invite-email" name="email" type="email" label="Their email" autoComplete="off" inputMode="email" error={state.errors.email} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="invite-role" className="text-[14px] font-semibold text-navy-950">Role</label>
        <select id="invite-role" name="role" defaultValue="technician" aria-describedby="invite-role-help" className={inputClass}>
          {INVITE_ROLES.map((role) => (
            <option key={role} value={role}>{ROLE_LABELS[role]}</option>
          ))}
        </select>
        <ul id="invite-role-help" className="m-0 flex list-none flex-col gap-0.5 p-0 text-[13px] leading-5 text-grey-600">
          {INVITE_ROLES.map((role) => (
            <li key={role}><strong className="text-grey-700">{ROLE_LABELS[role]}:</strong> {ROLE_DESCRIPTIONS[role]}</li>
          ))}
        </ul>
      </div>
      {state.message ? (
        <div data-form-message tabIndex={-1} className="outline-none"><Notice tone="error" role="alert">{state.message}</Notice></div>
      ) : null}
      {state.sent ? <InviteSentNotice sent={state.sent} /> : null}
      <button type="submit" disabled={pending} className={buttonClass("primary", "md", "w-full sm:w-fit")}>{pending ? "Sending…" : "Send invite"}</button>
    </form>
  );
}
