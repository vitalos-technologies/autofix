"use client";

import { useActionState } from "react";
import { buttonClass } from "@/components/admin-ui/styles";
import { Notice, TextField } from "@/components/onboarding/field";
import { PASSWORD_MIN_LENGTH } from "@/lib/signup/schema";
import { acceptInviteAction, createAccountAndAcceptAction, signInAndAcceptAction, type InviteActionState } from "./actions";

const initial: InviteActionState = { seq: 0 };
const primary = buttonClass("primary", "md", "min-h-[54px] w-full text-[16px]");

export function AcceptInviteForm({ garageName }: { garageName: string }) {
  const [state, action, pending] = useActionState(acceptInviteAction, initial);
  return (
    <form action={action} className="flex flex-col gap-3">
      {state.message ? <Notice tone="error" role="alert">{state.message}</Notice> : null}
      <button type="submit" disabled={pending} className={primary}>{pending ? "Joining…" : `Join ${garageName}`}</button>
    </form>
  );
}

export function SignInAndAcceptForm({ email }: { email: string }) {
  const [state, action, pending] = useActionState(signInAndAcceptAction, initial);
  return (
    <form action={action} className="flex flex-col gap-4 rounded-card border border-grey-200 bg-white p-5">
      <p className="m-0 text-[15px] text-grey-700">Sign in as <strong className="text-navy-950">{email}</strong> to accept.</p>
      <TextField id="invite-password" name="password" type="password" label="Password" autoComplete="current-password" required error={state.field === "password" ? state.message : undefined} />
      {state.message && state.field !== "password" ? <Notice tone="error" role="alert">{state.message}</Notice> : null}
      <button type="submit" disabled={pending} className={primary}>{pending ? "Signing in…" : "Sign in and join"}</button>
    </form>
  );
}

export function CreateAccountAndAcceptForm({ email }: { email: string }) {
  const [state, action, pending] = useActionState(createAccountAndAcceptAction, initial);
  return (
    <form action={action} className="flex flex-col gap-4 rounded-card border border-grey-200 bg-white p-5">
      <p className="m-0 text-[15px] text-grey-700">Your account will use <strong className="text-navy-950">{email}</strong>.</p>
      <TextField id="invite-name" name="name" label="Your name" autoComplete="name" required error={state.field === "name" ? state.message : undefined} />
      <TextField
        id="invite-new-password"
        name="password"
        type="password"
        label="Choose a password"
        hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
        autoComplete="new-password"
        required
        minLength={PASSWORD_MIN_LENGTH}
        error={state.field === "password" ? state.message : undefined}
      />
      {state.message && !state.field ? <Notice tone="error" role="alert">{state.message}</Notice> : null}
      <button type="submit" disabled={pending} className={primary}>{pending ? "Creating your account…" : "Create account and join"}</button>
    </form>
  );
}
