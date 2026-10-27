"use client";

import { useActionState } from "react";
import { buttonClass, SubmitButton } from "@/components/admin-ui";
import type { RuleKind } from "@/lib/reminders/rules";
import { initialSetupFormState, type SetupFormState } from "@/lib/settings/setup";
import { FormMessage } from "../settings/_components/fields";
import { sendTestAction } from "./actions";

/** "Send me a test": the saved wording of one automation, to the signed-in member's own mobile or email. */
export function TestSendForm({ kind, hint }: { kind: RuleKind; hint?: string }) {
  const [state, formAction] = useActionState<SetupFormState, FormData>(sendTestAction, initialSetupFormState);
  return (
    <form action={formAction} className="flex flex-col gap-2.5">
      <input type="hidden" name="kind" value={kind} />
      <SubmitButton className={buttonClass("secondary", "md", "w-full")}>
        Send me a test
      </SubmitButton>
      {hint ? <p className="m-0 text-[13px] text-grey-600">{hint}</p> : null}
      <FormMessage state={state} />
    </form>
  );
}
