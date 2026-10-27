"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { buttonClass, SubmitButton, TemplateEditor } from "@/components/admin-ui";
import type { TemplateVariables } from "@/lib/messaging/templates";
import {
  allowedPlaceholders,
  CHANNEL_OPTIONS,
  checkTemplate,
  MAX_OFFSETS,
  OFFSET_LABELS,
  RULE_CHANNELS,
  type RuleChannel,
  type RuleKind,
} from "@/lib/reminders/rules";
import { initialSetupFormState, type SetupFormState } from "@/lib/settings/setup";
import { FormMessage, SelectField, TextInputField } from "../settings/_components/fields";
import { saveRuleAction, type RuleField } from "./actions";

export type RuleEditorProps = {
  kind: RuleKind;
  template: string;
  offsets: number[];
  channel: RuleChannel;
  sampleValues: TemplateVariables;
  senderName: string;
  canEdit: boolean;
};

const OFFSET_HINTS: Partial<Record<RuleKind, string>> = {
  mot: `For example 28, 7 sends four weeks and one week before. Up to ${MAX_OFFSETS}.`,
  service: `335 is 11 months after the last service. Up to ${MAX_OFFSETS}.`,
  review: "1 sends the day after the car is collected.",
};

function previewChannel(channel: RuleChannel) {
  return channel === "whatsapp" ? "whatsapp" : channel === "email" ? "email" : "sms";
}

/**
 * The rule editor (P3.10): wording with placeholder chips, a live character and text count and the
 * same checks the server makes (unknown placeholders are refused, as the sender refuses them), the
 * timing and the channel, with a preview filled in with sample details.
 */
export function RuleEditor({ kind, template, offsets, channel: savedChannel, sampleValues, senderName, canEdit }: RuleEditorProps) {
  const [state, formAction] = useActionState<SetupFormState<RuleField>, FormData>(saveRuleAction, initialSetupFormState);
  const [text, setText] = useState(template);
  const [channel, setChannel] = useState<RuleChannel>(savedChannel);
  const handled = useRef(state.seq);
  const check = checkTemplate(kind, text);
  const channels = RULE_CHANNELS.filter((value) => kind !== "missed_call" || value !== "email");

  useEffect(() => {
    if (state.seq === handled.current) return;
    handled.current = state.seq;
    const first = (["template", "offsets", "channel"] as const).find((field) => state.fieldErrors?.[field]);
    if (first) document.getElementById(`rule-${first}`)?.focus();
  }, [state]);

  return (
    <form action={formAction} noValidate className="flex flex-col gap-4">
      <input type="hidden" name="kind" value={kind} />
      <fieldset disabled={!canEdit} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
        <legend className="sr-only">Message and timing</legend>
        <TemplateEditor
          id="rule-template"
          label="Message"
          hint={
            kind === "missed_call"
              ? "Sent to callers we couldn't answer. “Reply STOP to opt out.” is added for you."
              : "“Reply STOP to opt out.” is added to texts and WhatsApp, and emails get a link to stop reminders."
          }
          value={text}
          onChange={setText}
          placeholders={allowedPlaceholders(kind)}
          sampleValues={sampleValues}
          channel={previewChannel(channel)}
          senderName={senderName}
          errors={check.errors}
          warnings={check.warnings}
        />
        {OFFSET_LABELS[kind] ? (
          <TextInputField
            id="rule-offsets"
            name="offsets"
            label={OFFSET_LABELS[kind]}
            hint={OFFSET_HINTS[kind]}
            defaultValue={offsets.join(", ")}
            inputMode="numeric"
            autoComplete="off"
            error={state.fieldErrors?.offsets}
            fieldClassName="max-w-[240px]"
          />
        ) : null}
        <SelectField
          id="rule-channel"
          name="channel"
          label="Send by"
          value={channel}
          onChange={(event) => setChannel(event.target.value as RuleChannel)}
          error={state.fieldErrors?.channel}
          hint={
            channel !== "customer"
              ? undefined
              : kind === "missed_call"
                ? "Callers who are customers get it the way they chose; anyone else gets a text."
                : "The way each customer asked to hear from you: text, WhatsApp or email."
          }
        >
          {channels.map((value) => (
            <option key={value} value={value}>
              {kind === "missed_call" && value === "customer" ? "The caller's choice" : CHANNEL_OPTIONS[value]}
            </option>
          ))}
        </SelectField>
      </fieldset>
      <FormMessage state={state} />
      <div className="flex flex-wrap gap-2.5">
        {canEdit ? <SubmitButton className={buttonClass("primary", "md", "flex-1 sm:flex-none")}>Save changes</SubmitButton> : null}
        <Link href="/app/reminders" className={buttonClass("secondary", "md", "flex-1 sm:flex-none")}>
          {canEdit ? "Cancel" : "Close"}
        </Link>
      </div>
    </form>
  );
}
