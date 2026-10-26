import { Fragment, type ReactNode } from "react";
import { renderTemplate, smsSegments, type SmsSegmentInfo, type TemplateVariables } from "@/lib/messaging/templates";
import { cn } from "@/lib/utils";

export type PreviewChannel = "sms" | "whatsapp" | "email";

export type MessagePreviewProps = {
  /** Template with `{first_name}`-style placeholders. */
  template: string;
  /** Sample values for the placeholders. */
  values: TemplateVariables;
  channel?: PreviewChannel;
  /** Sender shown above the bubble, e.g. the garage's SMS sender "HartleyRd". */
  senderName?: string;
  /** Show the character and text count under the bubble (SMS only). Default true. */
  showCount?: boolean;
  /** id for the count line, so an editor can point `aria-describedby` at it. */
  countId?: string;
  className?: string;
};

const CHANNEL_NAMES: Record<PreviewChannel, string> = { sms: "Text message", whatsapp: "WhatsApp", email: "Email" };

// Bare or https links in the rendered text, drawn underlined like a phone does.
const LINK = /(https?:\/\/[^\s]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[^\s]*)/gi;

function withLinks(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    const index = match.index ?? 0;
    let url = match[0];
    const trailing = /[.,!?)]+$/.exec(url)?.[0] ?? "";
    url = trailing ? url.slice(0, -trailing.length) : url;
    if (index > last) nodes.push(text.slice(last, index));
    nodes.push(
      <span key={`${index}-${url}`} className="break-all text-accent underline">
        {url}
      </span>,
    );
    last = index + url.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** "142 characters · 1 text" or "171 characters · 2 texts" (GSM-7), or the Unicode equivalent. */
export function describeSegments(info: SmsSegmentInfo): string {
  const texts = `${info.segments} ${info.segments === 1 ? "text" : "texts"}`;
  return `${info.characters} ${info.characters === 1 ? "character" : "characters"} · ${texts}`;
}

/**
 * SMS bubble showing a template rendered with sample values, as the customer would see it, with the
 * opt-out line added for SMS and WhatsApp. Uses `renderTemplate` and `smsSegments` from
 * src/lib/messaging/templates.ts, the same code that sends.
 */
export function MessagePreview({ template, values, channel = "sms", senderName, showCount = true, countId, className }: MessagePreviewProps) {
  const rendered = renderTemplate(template, values, { channel });
  const info = smsSegments(rendered.text);
  const overOne = channel === "sms" && info.segments > 1;
  const lines = rendered.text.split("\n");

  return (
    <div className={cn("flex flex-col gap-2 font-sans leading-[normal]", className)}>
      <figure className="m-0 flex flex-col gap-2 rounded-[18px] bg-grey-100 p-4">
        <figcaption className="text-center text-[12px] font-semibold text-grey-600">
          {[senderName, CHANNEL_NAMES[channel]].filter(Boolean).join(" · ")}
        </figcaption>
        <div className="max-w-[92%] self-start rounded-[16px_16px_16px_4px] bg-white px-3.5 py-3 text-[14px] leading-[1.45] break-words text-grey-800">
          {rendered.text ? (
            lines.map((line, index) => (
              <Fragment key={index}>
                {index > 0 ? <br /> : null}
                {withLinks(line)}
              </Fragment>
            ))
          ) : (
            <span className="text-grey-600">Nothing to send yet.</span>
          )}
        </div>
      </figure>
      {showCount && channel === "sms" ? (
        <p id={countId} className={cn("m-0 text-[13px]", overOne ? "font-semibold text-warning-ink" : "text-grey-600")}>
          {describeSegments(info)}
          {info.encoding === "UCS-2" ? ` · Unicode (${info.perSegment} characters a text)` : ""}
        </p>
      ) : null}
      {rendered.unknownPlaceholders.length > 0 ? (
        <p className="m-0 text-[13px] font-semibold text-[#991b1b]">Not a placeholder: {rendered.unknownPlaceholders.join(", ")}</p>
      ) : null}
      {rendered.missingPlaceholders.length > 0 ? (
        <p className="m-0 text-[13px] text-grey-600">No sample value for {rendered.missingPlaceholders.map((name) => `{${name}}`).join(", ")}</p>
      ) : null}
    </div>
  );
}
