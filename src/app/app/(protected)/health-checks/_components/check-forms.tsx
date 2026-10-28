"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Send } from "lucide-react";
import { SubmitButton, buttonClass } from "@/components/admin-ui";
import { HEALTH_CHECK_SECTIONS, SECTION_LABELS } from "@/lib/health-checks/checklist";
import { FormMessage, SelectField, TextAreaField, TextInputField } from "../../settings/_components/fields";
import { addItemAction, saveSummaryAction, sendHealthCheckAction, type HealthCheckFormState } from "../actions";

const initial: HealthCheckFormState = { seq: 0, status: "idle" };

/** The note to the customer and the mileage. */
export function SummaryForm({ checkId, summary, mileage }: { checkId: string; summary: string | null; mileage: number | null }) {
  const [state, action] = useActionState(saveSummaryAction, initial);
  return (
    <form action={action} className="flex flex-col gap-3.5">
      <input type="hidden" name="checkId" value={checkId} />
      <TextAreaField
        id="hc-summary"
        name="summary"
        label="Note to the customer"
        hint="Shown at the top of their health check. Optional."
        defaultValue={summary ?? ""}
        maxLength={1000}
        rows={3}
        error={state.fieldErrors?.summary}
      />
      <TextInputField id="hc-mileage" name="mileage" label="Mileage" inputMode="numeric" defaultValue={mileage === null ? "" : String(mileage)} error={state.fieldErrors?.mileage} fieldClassName="max-w-[220px]" />
      <FormMessage state={state} />
      <SubmitButton className={buttonClass("secondary", "md", "w-full sm:w-fit")}>Save note and mileage</SubmitButton>
    </form>
  );
}

/** A line of the technician's own. */
export function AddItemForm({ checkId }: { checkId: string }) {
  const [state, action] = useActionState(addItemAction, initial);
  return (
    <form action={action} className="flex flex-col gap-3.5" key={state.status === "saved" ? state.seq : "form"}>
      <input type="hidden" name="checkId" value={checkId} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[200px_minmax(0,1fr)]">
        <SelectField id="hc-new-section" name="section" label="Section" defaultValue="other" error={state.fieldErrors?.section}>
          {HEALTH_CHECK_SECTIONS.filter((section) => section !== "mot").map((section) => (
            <option key={section} value={section}>
              {SECTION_LABELS[section]}
            </option>
          ))}
        </SelectField>
        <TextInputField id="hc-new-label" name="label" label="What you checked" maxLength={120} error={state.fieldErrors?.label} />
      </div>
      <FormMessage state={state} />
      <SubmitButton className={buttonClass("secondary", "md", "w-full sm:w-fit")}>Add line</SubmitButton>
    </form>
  );
}

/** Send (or send again with a new link) to the booking's customer. */
export function SendForm({ checkId, label }: { checkId: string; label: string }) {
  const [state, action] = useActionState(sendHealthCheckAction, initial);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="checkId" value={checkId} />
      <FormMessage state={state} />
      <SubmitButton className={buttonClass("primary", "md", "min-h-[54px] w-full text-[16px]")}>
        <Send size={18} strokeWidth={2} aria-hidden="true" />
        {label}
      </SubmitButton>
    </form>
  );
}

/**
 * While the customer has the link: refresh the page every 15 seconds (only while the tab is
 * visible), so their answer appears without a reload.
 */
export function LiveRefresh({ seconds = 15 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => window.clearInterval(timer);
  }, [router, seconds]);
  return null;
}
