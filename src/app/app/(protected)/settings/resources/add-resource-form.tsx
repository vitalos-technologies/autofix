"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { buttonClass, SubmitButton } from "@/components/admin-ui";
import { initialSetupFormState, MAX_RESOURCE_NAME, RESOURCE_KIND_LABELS, RESOURCE_KINDS, type ResourceField, type ResourceKind, type SetupFormState } from "@/lib/settings/setup";
import { ChoiceGroup, FormMessage, TextInputField } from "../_components/fields";
import { addResourceAction } from "./actions";

const KIND_HINTS: Record<ResourceKind, string> = {
  bay: "Takes workshop bookings for services that use a bay.",
  mobile: "Takes mobile visits, with travel time before and after.",
  technician: "For services that need a person rather than a bay.",
};

/** Add a bay, mobile van or technician. */
export function AddResourceForm() {
  const [state, formAction] = useActionState<SetupFormState<ResourceField>, FormData>(addResourceAction, initialSetupFormState);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ResourceKind>("bay");
  const [clearedSeq, setClearedSeq] = useState(state.seq);
  const handled = useRef(state.seq);

  if (state.seq !== clearedSeq) {
    setClearedSeq(state.seq);
    if (state.status === "saved") setName("");
  }

  useEffect(() => {
    if (state.seq === handled.current) return;
    handled.current = state.seq;
    if (state.fieldErrors?.name) document.getElementById("resource-name")?.focus();
  }, [state]);

  return (
    <form action={formAction} noValidate className="flex flex-col gap-4">
      <ChoiceGroup
        id="resource-kind"
        name="kind"
        legend="Type"
        options={RESOURCE_KINDS.map((value) => ({ value, label: RESOURCE_KIND_LABELS[value] }))}
        value={kind}
        onChange={setKind}
        error={state.fieldErrors?.kind}
        hint={KIND_HINTS[kind]}
      />
      <TextInputField
        id="resource-name"
        name="name"
        label="Name"
        maxLength={MAX_RESOURCE_NAME}
        autoComplete="off"
        placeholder={kind === "bay" ? "Bay 4" : kind === "mobile" ? "Mobile van 2" : "Technician 1"}
        value={name}
        onChange={(event) => setName(event.target.value)}
        error={state.fieldErrors?.name}
        fieldClassName="max-w-[420px]"
      />
      <FormMessage state={state} />
      <SubmitButton className={buttonClass("primary", "md", "w-full sm:w-fit")}>Add {RESOURCE_KIND_LABELS[kind].toLowerCase()}</SubmitButton>
    </form>
  );
}
