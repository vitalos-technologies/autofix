"use client";

import { useActionState } from "react";
import { buttonClass } from "@/components/admin-ui/styles";
import { Notice } from "@/components/onboarding/field";
import { resendInviteAction, type InviteFormState } from "@/lib/team/actions";
import { InviteSentNotice } from "./invite-form";

/** "Send again": a new link (the old one stops working) and a new 7 days. */
export function ResendInviteButton({ inviteId, email }: { inviteId: string; email: string }) {
  const [state, action, pending] = useActionState<InviteFormState, FormData>(resendInviteAction, { seq: 0, errors: {} });
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="inviteId" value={inviteId} />
      <button type="submit" disabled={pending} className={buttonClass("secondary", "sm")} aria-label={`Send the invite to ${email} again`}>
        {pending ? "Sending…" : "Send again"}
      </button>
      {state.message ? <Notice tone="error" role="alert">{state.message}</Notice> : null}
      {state.sent ? <InviteSentNotice sent={state.sent} /> : null}
    </form>
  );
}
