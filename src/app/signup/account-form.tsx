"use client";

import { useActionState, useCallback, useEffect, useRef, useState } from "react";
import { buttonClass } from "@/components/admin-ui/styles";
import { TurnstileField } from "@/components/forms/turnstile-field";
import { Notice, TextField } from "@/components/onboarding/field";
import { PASSWORD_MIN_LENGTH } from "@/lib/signup/schema";
import { signUpAction, type AccountFormState } from "./actions";

const initialAccountFormState: AccountFormState = { seq: 0, errors: {} };

/** Step 0: name, email and password. Errors sit on their fields; the first one gets focus. */
export function AccountForm() {
  const [state, action, pending] = useActionState(signUpAction, initialAccountFormState);
  const [turnstile, setTurnstile] = useState("");
  const onToken = useCallback((token: string) => setTurnstile(token), []);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!state.seq) return;
    const first = formRef.current?.querySelector<HTMLElement>("[aria-invalid='true'], [data-form-message]");
    first?.focus();
  }, [state]);

  return (
    <form ref={formRef} action={action} noValidate className="flex flex-col gap-4 rounded-card border border-grey-200 bg-white p-5">
      <TextField id="signup-name" name="name" label="Your name" autoComplete="name" required defaultValue={state.values?.name} error={state.errors.name} />
      <TextField
        id="signup-email"
        name="email"
        type="email"
        label="Email"
        hint="Your work email. We send a link to confirm it."
        autoComplete="email"
        inputMode="email"
        required
        defaultValue={state.values?.email}
        error={state.errors.email}
      />
      <TextField
        id="signup-password"
        name="password"
        type="password"
        label="Password"
        hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
        autoComplete="new-password"
        required
        minLength={PASSWORD_MIN_LENGTH}
        error={state.errors.password}
      />
      <input type="hidden" name="cf-turnstile-response" value={turnstile} />
      <TurnstileField onToken={onToken} />
      {state.message ? (
        <div data-form-message tabIndex={-1} className="outline-none">
          <Notice tone="error" role="alert">{state.message}</Notice>
        </div>
      ) : null}
      <button type="submit" disabled={pending} className={buttonClass("primary", "md", "min-h-[54px] w-full text-[16px]")}>
        {pending ? "Creating your account…" : "Create account"}
      </button>
      <p className="m-0 text-[13px] leading-5 text-grey-600">
        During set-up you read and accept the data processing agreement between your garage and Vitalos.
      </p>
    </form>
  );
}
