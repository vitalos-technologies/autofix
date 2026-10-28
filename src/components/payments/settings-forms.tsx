"use client";

import { useActionState } from "react";
import { buttonClass, SubmitButton } from "@/components/admin-ui";
import { CheckboxField, TextInputField } from "@/app/app/(protected)/settings/_components/fields";
import { SetupNotice } from "@/app/app/(protected)/settings/_components/setup-nav";
import { saveServiceDepositAction, savePaymentSettingsAction, type PaymentsFormState } from "@/lib/payments/admin-actions";
import type { DefaultDepositMode, ServiceDepositMode } from "@/lib/payments/amounts";
import { DepositRuleFields } from "./deposit-rule-fields";

const initial: PaymentsFormState = { seq: 0, status: "idle" };

function Outcome({ state }: { state: PaymentsFormState }) {
  if (state.status === "saved" && state.message) return <SetupNotice tone="success">{state.message}</SetupNotice>;
  if (state.status === "error" && state.message) return <SetupNotice tone="danger">{state.message}</SetupNotice>;
  return null;
}

export type PaymentSettingsFormValues = {
  depositsEnabled: boolean;
  defaultMode: DefaultDepositMode;
  defaultValue: number | null;
  holdMin: number;
  noShowFeePence: number | null;
  /** A service has its own deposit, so "no default" still takes deposits. */
  anyServiceDeposit: boolean;
};

/** Deposits on/off, the default deposit, the hold and the no-show fee (owners and managers). */
export function PaymentSettingsForm({ values, disabled }: { values: PaymentSettingsFormValues; disabled: boolean }) {
  const [state, action] = useActionState(savePaymentSettingsAction, initial);
  const errors = state.fieldErrors ?? {};
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <Outcome state={state} />
      <CheckboxField
        id="payments-deposits-enabled"
        name="depositsEnabled"
        label="Take a deposit when customers book online"
        hint="The booking holds the time while they pay; if they don't pay in time, the time is released."
        defaultChecked={values.depositsEnabled}
        disabled={disabled}
      />
      <input type="hidden" name="anyServiceDeposit" value={values.anyServiceDeposit ? "yes" : "no"} />
      <DepositRuleFields
        idPrefix="payments-default"
        names={{ mode: "defaultMode", amount: "defaultAmount", percent: "defaultPercent" }}
        modes={["none", "fixed", "percent"]}
        initialMode={values.defaultMode}
        initialValue={values.defaultValue}
        legend="Default deposit for every service"
        errors={{ mode: errors.defaultMode, amount: errors.defaultAmount, percent: errors.defaultPercent }}
        disabled={disabled}
      />
      <TextInputField
        id="payments-hold"
        name="holdMin"
        label="Hold the time for"
        suffix="minutes"
        inputMode="numeric"
        defaultValue={String(values.holdMin)}
        hint="From 30 to 180 minutes."
        error={errors.holdMin}
        disabled={disabled}
      />
      <TextInputField
        id="payments-no-show-fee"
        name="noShowFee"
        label="No-show fee"
        prefix="£"
        inputMode="decimal"
        defaultValue={values.noShowFeePence !== null ? (values.noShowFeePence / 100).toFixed(2) : ""}
        hint="Charged by link when you mark a booking as a no-show. Leave empty for none."
        error={errors.noShowFee}
        disabled={disabled}
      />
      <SubmitButton className={buttonClass("primary", "md", "w-full sm:w-fit")} disabled={disabled}>
        Save payment settings
      </SubmitButton>
    </form>
  );
}

/** One service's deposit (on the service's edit page). */
export function ServiceDepositForm({ serviceId, mode, value, disabled }: { serviceId: string; mode: ServiceDepositMode; value: number | null; disabled: boolean }) {
  const [state, action] = useActionState(saveServiceDepositAction, initial);
  const errors = state.fieldErrors ?? {};
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <Outcome state={state} />
      <input type="hidden" name="serviceId" value={serviceId} />
      <DepositRuleFields
        idPrefix="service-deposit"
        names={{ mode: "mode", amount: "amount", percent: "percent" }}
        modes={["default", "none", "fixed", "percent"]}
        initialMode={mode}
        initialValue={value}
        legend="Deposit when booked online"
        errors={{ mode: errors.mode, amount: errors.amount, percent: errors.percent }}
        disabled={disabled}
      />
      <SubmitButton className={buttonClass("secondary", "md", "w-full sm:w-fit")} disabled={disabled}>
        Save deposit
      </SubmitButton>
    </form>
  );
}
