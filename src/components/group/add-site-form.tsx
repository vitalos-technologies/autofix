"use client";

import { useActionState, useEffect, useRef } from "react";
import { buttonClass } from "@/components/admin-ui/styles";
import { Notice, TextField } from "@/components/onboarding/field";
import { addSiteAction, type AddSiteFormState } from "@/lib/group/actions";
import { extraSitesLabel } from "@/lib/group/report";

const initial: AddSiteFormState = { seq: 0, errors: {} };

/**
 * Add a site (P5.9): the new garage's name, phone, address and free booking link. It is created with
 * the usual defaults (services, hours, reminders), the owner is its owner, and it shares the group's
 * plan. Its opening hours, services and booking page are set up from the garage switcher afterwards.
 */
export function AddSiteForm({ linkExample }: { linkExample: string }) {
  const [state, action, pending] = useActionState(addSiteAction, initial);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!state.seq) return;
    if (state.added) formRef.current?.reset();
    formRef.current?.querySelector<HTMLElement>("[aria-invalid='true'], [data-form-message]")?.focus();
  }, [state]);

  return (
    <form ref={formRef} action={action} noValidate className="flex flex-col gap-4" aria-label="Add a site">
      <TextField id="site-name" name="name" label="Garage name" autoComplete="organization" error={state.errors.name} />
      <TextField id="site-phone" name="phone" type="tel" label="Phone customers call" autoComplete="tel" inputMode="tel" error={state.errors.phone} />
      <TextField id="site-email" name="email" type="email" label="Email (optional)" autoComplete="email" inputMode="email" error={state.errors.email} />
      <TextField id="site-line1" name="line1" label="Address line 1" autoComplete="address-line1" error={state.errors.line1} />
      <TextField id="site-line2" name="line2" label="Address line 2 (optional)" autoComplete="address-line2" error={state.errors.line2} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField id="site-town" name="town" label="Town or city" autoComplete="address-level2" error={state.errors.town} />
        <TextField id="site-postcode" name="postcode" label="Postcode" autoComplete="postal-code" error={state.errors.postcode} />
      </div>
      <TextField
        id="site-slug"
        name="slug"
        label="Free booking link"
        hint={`Lower-case letters, numbers and hyphens. Customers book at ${linkExample}; you can add your own domain later.`}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        error={state.errors.slug}
      />
      {state.message ? (
        <div data-form-message tabIndex={-1} className="outline-none"><Notice tone="error" role="alert">{state.message}</Notice></div>
      ) : null}
      {state.added ? (
        <div data-form-message tabIndex={-1} className="outline-none">
          <Notice tone="success" role="status">
            {state.added.name} is added to your group ({extraSitesLabel(state.added.extraSites)}). Switch to it from the garage menu to set its hours,
            services and booking page.
            {state.added.billingRecorded ? "" : " The extra-site charge could not be updated just now; it is logged for Vitalos to check."}
          </Notice>
        </div>
      ) : null}
      <button type="submit" disabled={pending} className={buttonClass("primary", "md", "w-full sm:w-fit")}>{pending ? "Adding…" : "Add site"}</button>
    </form>
  );
}
