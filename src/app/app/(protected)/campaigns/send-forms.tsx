"use client";

import { useActionState, useState } from "react";
import { buttonClass, SubmitButton } from "@/components/admin-ui";
import { initialSetupFormState, type SetupFormState } from "@/lib/settings/setup";
import { ChoiceGroup, FormMessage, TextInputField } from "../settings/_components/fields";
import { scheduleCampaignAction, sendCampaignTestAction } from "./actions";

/**
 * Send now or at a date and time (the garage's time zone). Messages only go 09:00-19:00 Monday to
 * Saturday: outside that window they wait for the next one, which the hint says.
 */
export function ScheduleForm({ id, recipients, defaultAt, minAt, timeZoneLabel }: { id: string; recipients: number; defaultAt: string; minAt: string; timeZoneLabel: string }) {
  const [when, setWhen] = useState<"now" | "later">("now");
  return (
    <form action={scheduleCampaignAction} className="flex flex-col gap-3.5">
      <input type="hidden" name="id" value={id} />
      <ChoiceGroup
        id="campaign-when"
        name="when"
        legend="When"
        value={when}
        onChange={setWhen}
        options={[
          { value: "now", label: "Send now" },
          { value: "later", label: "Pick a time" },
        ]}
        hint="Messages go 09:00–19:00, Monday to Saturday. Outside those hours they wait until the next morning."
      />
      {when === "later" ? (
        <TextInputField id="campaign-send-at" name="sendAt" type="datetime-local" label={`Date and time (${timeZoneLabel})`} defaultValue={defaultAt} min={minAt} required />
      ) : null}
      <SubmitButton className={buttonClass("primary", "md", "w-full")}>
        {when === "now" ? `Send to ${recipients.toLocaleString("en-GB")} ${recipients === 1 ? "customer" : "customers"}` : "Schedule"}
      </SubmitButton>
      <p className="m-0 text-[13px] text-grey-600">The customers who match when you press this get it. Anyone who opts out before their message goes is skipped.</p>
    </form>
  );
}

/** "Send me a test": the saved wording with sample details, to the member's own mobile or email. */
export function CampaignTestForm({ id }: { id: string }) {
  const [state, formAction] = useActionState<SetupFormState, FormData>(sendCampaignTestAction, initialSetupFormState);
  return (
    <form action={formAction} className="flex flex-col gap-2.5">
      <input type="hidden" name="id" value={id} />
      <SubmitButton className={buttonClass("secondary", "md", "w-full")}>Send me a test</SubmitButton>
      <p className="m-0 text-[13px] text-grey-600">Sends the saved message, with sample details, to your own mobile or email.</p>
      <FormMessage state={state} />
    </form>
  );
}
