"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { buttonClass, Panel, SubmitButton } from "@/components/admin-ui";
import { ACCOUNT_FIELD_ORDER, BILLING_HINTS, PAYMENT_TERMS_MAX, type AccountBilling, type AccountFormValues, type AccountKind } from "@/lib/accounts/view";
import { CheckboxField, ChoiceGroup, FormMessage, TextAreaField, TextInputField } from "../settings/_components/fields";
import { saveAccountAction, type AccountFormState } from "./actions";

const initial: AccountFormState = { seq: 0, status: "idle" };

const KIND_OPTIONS = [
  { value: "fleet", label: "Fleet" },
  { value: "trade", label: "Trade" },
] as const;

const BILLING_OPTIONS = [
  { value: "monthly", label: "Monthly statement" },
  { value: "per_invoice", label: "Invoice each job" },
] as const;

/** Add or edit a business account. Every field is checked again by the server action. */
export function AccountForm({ accountId, values, cancelHref }: { accountId: string | null; values: AccountFormValues; cancelHref: string }) {
  const [state, formAction] = useActionState(saveAccountAction, initial);
  const [kind, setKind] = useState<AccountKind>(values.kind);
  const [billing, setBilling] = useState<AccountBilling>(values.billing);
  const handled = useRef(state.seq);
  const errors = state.fieldErrors ?? {};

  useEffect(() => {
    if (state.seq === handled.current) return;
    handled.current = state.seq;
    const first = ACCOUNT_FIELD_ORDER.find((field) => state.fieldErrors?.[field]);
    if (first) document.getElementById(`account-${first}`)?.focus();
    else if (state.status === "error") document.getElementById("account-form-message")?.focus();
  }, [state]);

  return (
    <form action={formAction} className="flex flex-col gap-[18px]" noValidate>
      {accountId ? <input type="hidden" name="accountId" value={accountId} /> : null}
      <div id="account-form-message" tabIndex={-1} className="outline-none">
        <FormMessage state={state} />
      </div>

      <div className="flex flex-wrap items-start gap-[18px]">
        <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-[18px]">
          <Panel title="The business">
            <TextInputField id="account-name" name="name" label="Business name" defaultValue={values.name} error={errors.name} autoComplete="organization" maxLength={120} required />
            <ChoiceGroup id="account-kind" name="kind" legend="Type of account" options={KIND_OPTIONS} value={kind} onChange={setKind} error={errors.kind}
              hint={kind === "fleet" ? "A business whose cars you look after." : "A trade customer, such as another garage or a dealer."} />
            <TextInputField id="account-companyNumber" name="companyNumber" label="Company number (optional)" defaultValue={values.companyNumber} error={errors.companyNumber} autoComplete="off" maxLength={10} hint="8 characters, from Companies House." />
            <TextAreaField id="account-billingAddress" name="billingAddress" label="Billing address (optional)" defaultValue={values.billingAddress} error={errors.billingAddress} rows={3} maxLength={500} autoComplete="street-address" />
          </Panel>

          <Panel title="Contact">
            <TextInputField id="account-contactName" name="contactName" label="Contact name (optional)" defaultValue={values.contactName} error={errors.contactName} autoComplete="name" maxLength={120} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <TextInputField id="account-contactPhone" name="contactPhone" type="tel" inputMode="tel" label="Phone (optional)" defaultValue={values.contactPhone} error={errors.contactPhone} autoComplete="tel" />
              <TextInputField id="account-contactEmail" name="contactEmail" type="email" label="Email (optional)" defaultValue={values.contactEmail} error={errors.contactEmail} autoComplete="email" />
            </div>
          </Panel>
        </div>

        <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-[18px]">
          <Panel title="Billing">
            <ChoiceGroup id="account-billing" name="billing" legend="How they are billed" options={BILLING_OPTIONS} value={billing} onChange={setBilling} error={errors.billing} hint={BILLING_HINTS[billing]} />
            <TextInputField id="account-billingEmail" name="billingEmail" type="email" label={billing === "monthly" ? "Accounts email" : "Accounts email (optional)"} defaultValue={values.billingEmail} error={errors.billingEmail} autoComplete="email" hint="Statements are sent here." />
            <TextInputField id="account-paymentTermsDays" name="paymentTermsDays" inputMode="numeric" label="Payment terms" suffix="days" defaultValue={values.paymentTermsDays} error={errors.paymentTermsDays} hint={`0 to ${PAYMENT_TERMS_MAX}. The statement is due this many days after it is issued.`} />
            <CheckboxField id="account-poRequired" name="poRequired" label="Needs a PO number on every booking" defaultChecked={values.poRequired} hint="Bookings for this account can't be made without one." />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <TextInputField id="account-discountPercent" name="discountPercent" inputMode="decimal" label="Discount (optional)" suffix="%" defaultValue={values.discountPercent} error={errors.discountPercent} />
              <TextInputField id="account-creditLimit" name="creditLimit" inputMode="decimal" label="Credit limit (optional)" prefix="£" defaultValue={values.creditLimit} error={errors.creditLimit} />
            </div>
          </Panel>
          <Panel title="Notes">
            <TextAreaField id="account-notes" name="notes" label="Notes for the team (optional)" defaultValue={values.notes} error={errors.notes} rows={3} maxLength={2000} />
          </Panel>
          <div className="flex flex-wrap gap-3">
            <SubmitButton className={buttonClass("primary", "md", "min-h-[50px] grow")}>{accountId ? "Save account" : "Add account"}</SubmitButton>
            <Link href={cancelHref} className={buttonClass("ghost", "md", "min-h-[50px]")}>Cancel</Link>
          </div>
        </div>
      </div>
    </form>
  );
}
