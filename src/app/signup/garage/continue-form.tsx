"use client";

import { useActionState } from "react";
import { buttonClass } from "@/components/admin-ui/styles";
import { Notice, TextField } from "@/components/onboarding/field";
import { signInToContinueAction } from "../actions";

/** Sign in to carry on with set-up (an account with no garage yet cannot use the admin sign-in). */
export function ContinueForm() {
  const [state, action, pending] = useActionState(signInToContinueAction, { seq: 0 });
  return (
    <form action={action} className="flex flex-col gap-4 rounded-card border border-grey-200 bg-white p-5">
      <TextField id="continue-email" name="email" type="email" label="Email" autoComplete="username" required />
      <TextField id="continue-password" name="password" type="password" label="Password" autoComplete="current-password" required />
      {state.message ? <Notice tone="error" role="alert">{state.message}</Notice> : null}
      <button type="submit" disabled={pending} className={buttonClass("primary", "md", "min-h-[54px] w-full text-[16px]")}>
        {pending ? "Signing in…" : "Sign in and continue"}
      </button>
    </form>
  );
}
