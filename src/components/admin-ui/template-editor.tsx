"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import {
  REMINDER_PLACEHOLDERS,
  renderTemplate,
  smsSegments,
  type TemplatePlaceholder,
  type TemplateVariables,
} from "@/lib/messaging/templates";
import { cn } from "@/lib/utils";
import { MessagePreview, type PreviewChannel } from "./message-preview";
import { focusRing } from "./styles";

export type TemplateEditorProps = {
  /** Field label. Default "Message". */
  label?: string;
  /** Form field name. Default "template". */
  name?: string;
  /** Controlled value (use with `onChange`). */
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  /** Chips shown; default `{first_name}` `{vehicle}` `{reg}` `{due_date}` `{link}` `{garage}`. */
  placeholders?: readonly TemplatePlaceholder[];
  /** Sample values for the counter and preview. */
  sampleValues: TemplateVariables;
  channel?: PreviewChannel;
  /** SMS sender name shown in the preview. */
  senderName?: string;
  /** Show the MessagePreview under the field. Default true. */
  showPreview?: boolean;
  /** Help text under the label. */
  hint?: string;
  rows?: number;
  required?: boolean;
  id?: string;
  /**
   * Problems with the text as typed, e.g. from `checkTemplate` (src/lib/reminders/rules.ts): errors
   * block saving and mark the field invalid, warnings are advice. Shown under the counter.
   */
  errors?: readonly string[];
  warnings?: readonly string[];
  className?: string;
};

/**
 * Reminder template field: placeholder chips insert at the caret, and a live counter (with the sample
 * values and the opt-out line, as sent) warns when the text needs more than one SMS.
 */
export function TemplateEditor({
  label = "Message",
  name = "template",
  value,
  defaultValue = "",
  onChange,
  placeholders = REMINDER_PLACEHOLDERS,
  sampleValues,
  channel = "sms",
  senderName,
  showPreview = true,
  hint,
  rows = 5,
  required,
  id,
  errors = [],
  warnings = [],
  className,
}: TemplateEditorProps) {
  const autoId = useId();
  const fieldId = id ?? `${autoId}-template`;
  const hintId = `${fieldId}-hint`;
  const countId = `${fieldId}-count`;
  const problemsId = `${fieldId}-problems`;
  const hasProblems = errors.length > 0 || warnings.length > 0;
  const chipsLabelId = `${fieldId}-chips`;
  const [internal, setInternal] = useState(defaultValue);
  const text = value ?? internal;
  const area = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);

  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    if (caret === null || !area.current) return;
    pendingCaret.current = null;
    area.current.focus();
    area.current.setSelectionRange(caret, caret);
  });

  function update(next: string) {
    if (value === undefined) setInternal(next);
    onChange?.(next);
  }

  function insert(placeholder: TemplatePlaceholder) {
    const token = `{${placeholder}}`;
    const field = area.current;
    const start = field ? field.selectionStart : text.length;
    const end = field ? field.selectionEnd : text.length;
    pendingCaret.current = start + token.length;
    update(text.slice(0, start) + token + text.slice(end));
  }

  const rendered = renderTemplate(text, sampleValues, { channel });
  const info = smsSegments(rendered.text);
  const sms = channel === "sms";
  const tooLong = sms && info.segments > 1;
  const limit = info.encoding === "UCS-2" ? 70 : 160;
  const countText =
    (info.segments <= 1
      ? `${info.characters} of ${limit} characters${info.characters > 0 ? " · 1 text" : ""}`
      : `${info.characters} characters · ${info.segments} texts`) +
    (info.encoding === "UCS-2" ? " · Unicode" : "") +
    " (with sample details)";

  return (
    <div className={cn("flex flex-col gap-2.5 font-sans leading-[normal]", className)}>
      <div className="flex flex-col gap-1">
        <label htmlFor={fieldId} className="text-[14px] font-semibold text-grey-800">
          {label}
        </label>
        {hint ? (
          <p id={hintId} className="m-0 text-[13px] text-grey-600">
            {hint}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <span id={chipsLabelId} className="text-[12px] font-semibold text-grey-600">
          Insert at the cursor
        </span>
        <div role="group" aria-labelledby={chipsLabelId} className="flex flex-wrap gap-1.5">
          {placeholders.map((placeholder) => (
            <button
              key={placeholder}
              type="button"
              aria-controls={fieldId}
              onClick={() => insert(placeholder)}
              className={cn(
                "inline-flex min-h-11 items-center rounded-full border border-grey-300 bg-white px-3 font-mono text-[13px] font-medium text-navy-950 hover:border-grey-600",
                focusRing,
              )}
            >
              {`{${placeholder}}`}
            </button>
          ))}
        </div>
      </div>

      <textarea
        ref={area}
        id={fieldId}
        name={name}
        rows={rows}
        required={required}
        value={text}
        spellCheck
        aria-describedby={[hint ? hintId : null, sms ? countId : null, hasProblems || tooLong ? problemsId : null].filter(Boolean).join(" ") || undefined}
        aria-invalid={errors.length > 0 || undefined}
        onChange={(event) => update(event.target.value)}
        className={cn(
          "min-h-[120px] w-full resize-y rounded-input border bg-white px-3.5 py-3 font-sans text-[15px] leading-normal text-navy-950",
          "focus-visible:border-2 focus-visible:border-accent focus-visible:outline-none",
          errors.length > 0 ? "border-2 border-[#b91c1c]" : tooLong ? "border-[#b45309]" : "border-grey-300",
        )}
      />

      <div className="flex flex-col gap-1">
        {sms ? (
          <p id={countId} className={cn("m-0 text-[13px] tabular-nums", tooLong ? "font-semibold text-warning-ink" : "text-grey-600")}>
            {countText}
          </p>
        ) : null}
        <div id={problemsId} role="status" className="flex flex-col gap-1.5 text-[13px]">
          {tooLong ? (
            <p className="m-0 flex items-start gap-1.5 rounded-[10px] bg-warning-bg px-3 py-2 font-semibold text-warning-ink">
              <TriangleAlert size={18} strokeWidth={2} aria-hidden="true" className="mt-px shrink-0" />
              <span>
                This sends as {info.segments} texts, and each one is charged. Keep it to {limit} characters for one text
                {info.unicodeCharacters.length > 0 ? `, and swap ${info.unicodeCharacters.join(" ")} for plain characters` : ""}.
              </span>
            </p>
          ) : null}
          {errors.map((error) => (
            <p key={error} className="m-0 flex items-start gap-1.5 font-semibold text-[#b91c1c]">
              <CircleAlert size={18} strokeWidth={2} aria-hidden="true" className="mt-px shrink-0" />
              <span>{error}</span>
            </p>
          ))}
          {warnings.map((warning) => (
            <p key={warning} className="m-0 flex items-start gap-1.5 text-grey-700">
              <Info size={18} strokeWidth={2} aria-hidden="true" className="mt-px shrink-0" />
              <span>{warning}</span>
            </p>
          ))}
        </div>
      </div>

      {showPreview ? <MessagePreview template={text} values={sampleValues} channel={channel} senderName={senderName} showCount={false} /> : null}
    </div>
  );
}
