"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { Users } from "lucide-react";
import { PlateChip } from "@/components/book";
import { Badge, buttonClass, ChannelBadge, MessagePreview, Panel, SubmitButton, TemplateEditor } from "@/components/admin-ui";
import type { AudiencePreview, CampaignService } from "@/lib/campaigns/admin";
import { CAMPAIGN_CHANNELS, CHANNEL_NAMES, MONTH_NAMES, NOT_SEEN_CHOICES, type CampaignSegment } from "@/lib/campaigns/segment";
import { CAMPAIGN_PLACEHOLDERS, checkCampaignTemplate } from "@/lib/campaigns/templates";
import { CAMPAIGN_CONSENT_LABELS } from "@/lib/consent/offers";
import type { TemplateVariables } from "@/lib/messaging/templates";
import { initialSetupFormState, type SetupFormState } from "@/lib/settings/setup";
import { formatRegistration } from "@/lib/vehicle/registration-format";
import { FormMessage, SelectField, TextAreaField, TextInputField, hintClass, labelClass } from "../settings/_components/fields";
import { previewAudienceAction, saveCampaignAction, type CampaignField, type PreviewState } from "./actions";

export type CampaignEditorValues = {
  id?: string;
  starter?: string | null;
  name: string;
  segment: CampaignSegment;
  template: string;
  emailSubject: string;
  emailTemplate: string;
  serviceId: string;
};

export type CampaignEditorProps = {
  values: CampaignEditorValues;
  services: CampaignService[];
  motEnabled: boolean;
  sampleValues: TemplateVariables;
  senderName: string;
  initialPreview: AudiencePreview | null;
};

const FIELD_IDS: Record<CampaignField, string> = {
  name: "campaign-name",
  template: "campaign-template",
  emailSubject: "campaign-email-subject",
  emailTemplate: "campaign-email-template",
  serviceId: "campaign-service",
  carAge: "campaign-age-min",
  motMonths: "campaign-mot-months",
  notSeen: "campaign-not-seen",
  service: "campaign-history",
  channels: "campaign-channels",
};

const PREVIEW_DELAY_MS = 400;

function plural(count: number, one: string, many = `${one}s`) {
  return `${count.toLocaleString("en-GB")} ${count === 1 ? one : many}`;
}

/**
 * The campaign editor (P5.5): who gets it (segment builder with a live count and preview), the
 * wording (placeholder chips, the 160-character counter and a preview, with the opt-out line as
 * sent), the email variant, and the service the link opens. Saves a draft; scheduling is on the
 * draft's page.
 */
export function CampaignEditor({ values, services, motEnabled, sampleValues, senderName, initialPreview }: CampaignEditorProps) {
  const [state, formAction] = useActionState<SetupFormState<CampaignField>, FormData>(saveCampaignAction, initialSetupFormState);
  const [preview, previewAction] = useActionState<PreviewState, FormData>(previewAudienceAction, {
    seq: 0,
    status: initialPreview ? "ready" : "idle",
    ...(initialPreview ? { preview: initialPreview } : {}),
  });
  const [counting, startCounting] = useTransition();
  const [template, setTemplate] = useState(values.template);
  const [emailTemplate, setEmailTemplate] = useState(values.emailTemplate);
  const [emailSubject, setEmailSubject] = useState(values.emailSubject);
  const [history, setHistory] = useState<string>(values.segment.service_history ?? "any");
  const form = useRef<HTMLFormElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handled = useRef(state.seq);
  const check = checkCampaignTemplate(template);
  const segment = values.segment;
  const historyServices = services;

  useEffect(() => {
    if (state.seq === handled.current) return;
    handled.current = state.seq;
    const first = (Object.keys(FIELD_IDS) as CampaignField[]).find((field) => state.fieldErrors?.[field]);
    if (first) document.getElementById(FIELD_IDS[first])?.focus();
  }, [state]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  /** Re-count after a filter changes (debounced); the count runs in SQL on the server. */
  function recount() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!form.current) return;
      const data = new FormData(form.current);
      startCounting(() => previewAction(data));
    }, PREVIEW_DELAY_MS);
  }

  const result = preview.preview;

  return (
    <form ref={form} action={formAction} noValidate className="flex flex-col gap-[18px]">
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}
      {values.starter ? <input type="hidden" name="starter" value={values.starter} /> : null}

      <Panel title="Name" className="gap-3">
        <TextInputField
          id={FIELD_IDS.name}
          name="name"
          label="Campaign name"
          hint="Only your team sees this."
          defaultValue={values.name}
          maxLength={80}
          autoComplete="off"
          error={state.fieldErrors?.name}
        />
      </Panel>

      <Panel title="Who gets it" className="gap-4">
        <p className={hintClass}>
          Only customers who ticked the offers box when booking, or existing customers under the soft opt-in, who haven&apos;t opted out and
          have a car on file. Reminder consent alone isn&apos;t enough. Leave a filter empty to include everyone.
        </p>
        <fieldset onChange={recount} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
          <legend className="sr-only">Filters</legend>
          <div className="flex flex-col gap-1.5">
            <span id="campaign-age-label" className={labelClass}>
              Car age (years)
            </span>
            <div className="flex flex-wrap items-end gap-2.5">
              <TextInputField
                id={FIELD_IDS.carAge}
                name="carAgeMin"
                label="From"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="off"
                defaultValue={segment.car_age_min ?? ""}
                fieldClassName="w-[110px]"
                error={state.fieldErrors?.carAge}
              />
              <TextInputField
                id="campaign-age-max"
                name="carAgeMax"
                label="To"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="off"
                defaultValue={segment.car_age_max ?? ""}
                fieldClassName="w-[110px]"
              />
            </div>
          </div>

          {motEnabled ? (
            <fieldset id={FIELD_IDS.motMonths} tabIndex={-1} className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
              <legend className={`${labelClass} mb-1.5 p-0`}>MOT due in</legend>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                {MONTH_NAMES.map((month, index) => (
                  <label
                    key={month}
                    className="flex min-h-11 cursor-pointer items-center gap-2 rounded-input border border-grey-300 bg-white px-3 text-[14px] font-semibold text-navy-950 has-[:checked]:border-navy-950 has-[:checked]:bg-grey-100 has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent"
                  >
                    <input type="checkbox" name="motMonth" value={index + 1} defaultChecked={segment.mot_months?.includes(index + 1)} className="size-4 accent-accent" />
                    {month}
                  </label>
                ))}
              </div>
              {state.fieldErrors?.motMonths ? <p className="m-0 text-[13px] font-semibold text-[#b91c1c]">{state.fieldErrors.motMonths}</p> : null}
            </fieldset>
          ) : null}

          <SelectField
            id={FIELD_IDS.notSeen}
            name="notSeen"
            label="Last visit"
            defaultValue={segment.not_seen_months ? String(segment.not_seen_months) : ""}
            error={state.fieldErrors?.notSeen}
            hint="Customers with a booking coming up are left out of “not seen” campaigns."
            fieldClassName="max-w-[320px]"
          >
            <option value="">Any time</option>
            {NOT_SEEN_CHOICES.map((months) => (
              <option key={months} value={months}>
                Not seen for {months} months or more
              </option>
            ))}
          </SelectField>

          <div className="flex flex-wrap items-start gap-2.5">
            <SelectField
              id={FIELD_IDS.service}
              name="history"
              label="Service history"
              value={history}
              onChange={(event) => setHistory(event.target.value)}
              error={state.fieldErrors?.service}
              fieldClassName="w-[200px]"
            >
              <option value="any">Any</option>
              <option value="had">Have had</option>
              <option value="never">Have never had</option>
            </SelectField>
            {history !== "any" ? (
              <SelectField id="campaign-history-service" name="historyService" label="Service" defaultValue={segment.service_id ?? ""} fieldClassName="min-w-[200px] flex-1">
                <option value="">Choose a service</option>
                {historyServices.map((service) => (
                  <option key={service.id} value={service.id}>
                    {service.name}
                  </option>
                ))}
              </SelectField>
            ) : null}
          </div>

          <fieldset id={FIELD_IDS.channels} tabIndex={-1} className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
            <legend className={`${labelClass} mb-1.5 p-0`}>How they hear from you</legend>
            <div className="flex flex-wrap gap-2">
              {CAMPAIGN_CHANNELS.map((channel) => (
                <label
                  key={channel}
                  className="flex min-h-11 cursor-pointer items-center gap-2 rounded-input border border-grey-300 bg-white px-3.5 text-[14px] font-semibold text-navy-950 has-[:checked]:border-navy-950 has-[:checked]:bg-grey-100 has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent"
                >
                  <input type="checkbox" name="channel" value={channel} defaultChecked={!segment.channels || segment.channels.includes(channel)} className="size-4 accent-accent" />
                  {CHANNEL_NAMES[channel]}
                </label>
              ))}
            </div>
            <p className={hintClass}>Each customer gets it the way they chose. Untick a channel to leave those customers out.</p>
            {state.fieldErrors?.channels ? <p className="m-0 text-[13px] font-semibold text-[#b91c1c]">{state.fieldErrors.channels}</p> : null}
          </fieldset>
        </fieldset>

        <section aria-labelledby="campaign-audience-title" aria-busy={counting || undefined} className="flex flex-col gap-2.5 rounded-[12px] bg-grey-100 p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="campaign-audience-title" className="m-0 flex items-center gap-2 text-[15px] font-bold text-navy-950">
              <Users size={18} strokeWidth={2} aria-hidden="true" />
              <span role="status" aria-live="polite">
                {result ? `${plural(result.total, "customer")} match` : "Matching customers"}
                {counting ? " (updating)" : ""}
              </span>
            </h3>
            <button
              type="button"
              onClick={recount}
              className={buttonClass("secondary", "sm")}
            >
              Count again
            </button>
          </div>
          {result && result.total > 0 ? (
            <p className="m-0 text-[13px] text-grey-700">
              Ticked the offers box: {result.offersTotal.toLocaleString("en-GB")}. Existing customers (soft opt-in):{" "}
              {(result.total - result.offersTotal).toLocaleString("en-GB")}.
            </p>
          ) : null}
          {preview.status === "error" && preview.message ? (
            <p role="alert" className="m-0 text-[13px] font-semibold text-[#991b1b]">
              {preview.message}
            </p>
          ) : null}
          {result && result.rows.length > 0 ? (
            <ul aria-label="First matching customers" className="m-0 flex list-none flex-col gap-1.5 p-0">
              {result.rows.map((row) => (
                <li key={row.customerId} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-[10px] bg-white px-3 py-2 text-[14px]">
                  <span className="min-w-0 font-semibold text-navy-950">{row.name}</span>
                  <span className="text-grey-700 tabular-nums">{row.contact}</span>
                  {row.registration ? <PlateChip registration={formatRegistration(row.registration)} className="rounded-[4px] px-1.5 py-px text-[13px]" /> : null}
                  <span className="ml-auto flex items-center gap-1.5">
                    <Badge tone={row.basis === "offers" ? "success" : "neutral"} size="xs">
                      {CAMPAIGN_CONSENT_LABELS[row.basis]}
                    </Badge>
                    <ChannelBadge channel={row.channel} />
                  </span>
                </li>
              ))}
            </ul>
          ) : result ? (
            <p className="m-0 text-[13px] text-grey-700">Nobody matches these filters yet. Try a wider range.</p>
          ) : null}
          {result && result.total > result.rows.length ? (
            <p className="m-0 text-[13px] text-grey-700">and {plural(result.total - result.rows.length, "more")}.</p>
          ) : null}
        </section>
      </Panel>

      <Panel title="Message" className="gap-4">
        <TemplateEditor
          id={FIELD_IDS.template}
          label="Text and WhatsApp message"
          hint="“Reply STOP to opt out.” is added for you. Keep it to one text: 160 characters."
          value={template}
          onChange={setTemplate}
          placeholders={CAMPAIGN_PLACEHOLDERS}
          sampleValues={sampleValues}
          channel="sms"
          senderName={senderName}
          errors={state.fieldErrors?.template ? [state.fieldErrors.template] : check.errors}
          warnings={check.warnings}
        />
        <TextInputField
          id={FIELD_IDS.emailSubject}
          name="emailSubject"
          label="Email subject"
          value={emailSubject}
          onChange={(event) => setEmailSubject(event.target.value)}
          maxLength={150}
          autoComplete="off"
          error={state.fieldErrors?.emailSubject}
        />
        <TextAreaField
          id={FIELD_IDS.emailTemplate}
          name="emailTemplate"
          label="Email wording (optional)"
          hint="Leave empty to use the text message. Emails end with a link to stop these messages."
          value={emailTemplate}
          onChange={(event) => setEmailTemplate(event.target.value)}
          rows={4}
          error={state.fieldErrors?.emailTemplate}
        />
        <div className="flex flex-col gap-1.5">
          <span className={labelClass}>Email preview</span>
          <p className="m-0 text-[13px] text-grey-700">Subject: {emailSubject || "(none yet)"}</p>
          <MessagePreview template={emailTemplate.trim() || template} values={sampleValues} channel="email" senderName={senderName} />
        </div>
        <SelectField
          id={FIELD_IDS.serviceId}
          name="serviceId"
          label="The link opens"
          defaultValue={values.serviceId}
          hint="The booking page with the customer's car filled in, at this service's times."
          error={state.fieldErrors?.serviceId}
          fieldClassName="max-w-[420px]"
        >
          <option value="">The list of services (they choose)</option>
          {services.map((service) => (
            <option key={service.id} value={service.id}>
              {service.name}
            </option>
          ))}
        </SelectField>
      </Panel>

      <FormMessage state={state} />
      <div className="flex flex-wrap gap-2.5">
        <SubmitButton className={buttonClass("primary", "md", "flex-1 sm:flex-none")}>{values.id ? "Save draft" : "Save and continue"}</SubmitButton>
        <Link href="/app/campaigns" className={buttonClass("secondary", "md", "flex-1 sm:flex-none")}>
          Cancel
        </Link>
      </div>
    </form>
  );
}
