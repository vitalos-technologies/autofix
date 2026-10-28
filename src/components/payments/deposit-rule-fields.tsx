"use client";

import { useState } from "react";
import { SelectField, TextInputField } from "@/app/app/(protected)/settings/_components/fields";
import type { ServiceDepositMode } from "@/lib/payments/amounts";

const LABELS: Record<ServiceDepositMode, string> = {
  default: "Use the garage default",
  none: "No deposit",
  fixed: "A fixed amount",
  percent: "A percentage of the price",
};

/** Deposit rule inputs: how (select) and how much (pounds or percent), shown for the chosen way. */
export function DepositRuleFields({
  idPrefix,
  names,
  modes,
  initialMode,
  initialValue,
  errors,
  disabled,
  legend = "Deposit",
}: {
  idPrefix: string;
  names: { mode: string; amount: string; percent: string };
  modes: readonly ServiceDepositMode[];
  initialMode: ServiceDepositMode;
  initialValue: number | null;
  errors?: { mode?: string; amount?: string; percent?: string };
  disabled?: boolean;
  legend?: string;
}) {
  const [mode, setMode] = useState<ServiceDepositMode>(initialMode);
  return (
    <div className="flex flex-col gap-3">
      <SelectField
        id={`${idPrefix}-mode`}
        name={names.mode}
        label={legend}
        value={mode}
        disabled={disabled}
        error={errors?.mode}
        onChange={(event) => setMode(event.target.value as ServiceDepositMode)}
      >
        {modes.map((value) => (
          <option key={value} value={value}>
            {LABELS[value]}
          </option>
        ))}
      </SelectField>
      {mode === "fixed" ? (
        <TextInputField
          id={`${idPrefix}-amount`}
          name={names.amount}
          label="Amount"
          prefix="£"
          inputMode="decimal"
          autoComplete="off"
          defaultValue={initialMode === "fixed" && initialValue !== null ? (initialValue / 100).toFixed(2) : ""}
          hint="From £1 to £1,000."
          error={errors?.amount}
          disabled={disabled}
        />
      ) : null}
      {mode === "percent" ? (
        <TextInputField
          id={`${idPrefix}-percent`}
          name={names.percent}
          label="Percentage of the price"
          suffix="%"
          inputMode="numeric"
          autoComplete="off"
          defaultValue={initialMode === "percent" && initialValue !== null ? String(initialValue) : ""}
          hint="Services priced on a quote take no percentage deposit."
          error={errors?.percent}
          disabled={disabled}
        />
      ) : null}
    </div>
  );
}
