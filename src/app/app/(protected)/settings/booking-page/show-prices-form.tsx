"use client";

import { useActionState } from "react";
import { buttonClass, SubmitButton } from "@/components/admin-ui";
import { initialSetupFormState, type SetupFormState } from "@/lib/settings/setup";
import { CheckboxField, FormMessage } from "../_components/fields";
import { saveShowPricesAction } from "./actions";

/** "Show prices on my booking page" (on by default). Owners only, like the rest of the booking page. */
export function ShowPricesForm({ showPrices, canEdit }: { showPrices: boolean; canEdit: boolean }) {
  const [state, formAction] = useActionState<SetupFormState, FormData>(saveShowPricesAction, initialSetupFormState);
  return (
    <form action={formAction} noValidate className="flex flex-col gap-3">
      {/* Uncontrolled: React resets the form after the action, and the saved value comes back as the new
          default (the key remounts the box when it changes), so the box always shows what is saved. */}
      <CheckboxField
        key={showPrices ? "shown" : "hidden"}
        id="show-prices"
        name="showPrices"
        label="Show prices on my booking page"
        hint="When this is off, customers see your services without prices. A deposit still shows, because the customer pays it."
        defaultChecked={showPrices}
        disabled={!canEdit}
      />
      <FormMessage state={state} />
      <SubmitButton disabled={!canEdit} className={buttonClass("secondary", "md", "w-full sm:w-fit")}>
        Save prices setting
      </SubmitButton>
    </form>
  );
}
