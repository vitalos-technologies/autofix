import { CircleAlert, CircleCheck, Clock, PhoneForwarded, Smartphone, type LucideIcon } from "lucide-react";
import { Badge, CopyButton, Panel, textLinkClass } from "@/components/admin-ui";
import { aiDeskNumberView, landlineDivertText, mobileDivertCodes, type AiDeskNumber, type NumberStateView } from "@/lib/phone-numbers/state";
import { formatPhoneForDisplay, telHref } from "@/lib/tenancy/contact";
import { cn } from "@/lib/utils";

// Settings · AI front desk, "Your AI desk number" (D22). Where the garage's own number for the AI front desk
// stands (setting up, waiting for the upgrade or approval, waiting list, ready, failed with a reason) and, once
// it is ready, how to divert the garage's missed calls to it on a mobile or a landline (A432: this number never
// rings the garage back, so diverting to it cannot loop).

const STATE_STYLES: Record<NumberStateView["tone"], { box: string; icon: LucideIcon }> = {
  success: { box: "bg-success-bg text-success-ink", icon: CircleCheck },
  info: { box: "bg-info-bg text-info-ink", icon: Clock },
  warning: { box: "bg-warning-bg text-warning-ink", icon: Clock },
  neutral: { box: "bg-grey-100 text-grey-700", icon: Clock },
  danger: { box: "bg-[#fdecec] text-[#991b1b]", icon: CircleAlert },
};

function when(iso: string | null, timeZone: string) {
  if (!iso) return null;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(iso));
}

function DivertCode({ label, code }: { label: string; code: string }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-input border border-grey-200 bg-grey-50 px-3.5 py-2.5">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13px] font-semibold text-grey-700">{label}</span>
        <code className="font-mono text-[15px] font-medium break-all text-navy-950">{code}</code>
      </span>
      <CopyButton value={code} label="Copy" srSuffix={`code for ${label.toLowerCase()}`} size="sm" />
    </li>
  );
}

/** How to send the garage's missed calls to its AI desk number. */
export function ForwardingInstructions({ number }: { number: string }) {
  const mobile = mobileDivertCodes(number);
  return (
    <div className="flex flex-col gap-4 border-t border-grey-200 pt-4">
      <div className="flex flex-col gap-1">
        <h3 className="m-0 font-sans text-[15px] font-bold tracking-normal text-navy-950">Send your missed calls here</h3>
        <p className="m-0 text-[14px] leading-snug text-grey-700">
          Keep giving customers your usual number. Set it to divert the calls you can&apos;t take to this number: when nobody answers, when you&apos;re on another call and when the phone is off or has no signal.
        </p>
      </div>

      {mobile ? (
        <section aria-labelledby="divert-mobile" className="flex flex-col gap-2.5">
          <h4 id="divert-mobile" className="m-0 flex items-center gap-2 font-sans text-[14px] font-bold tracking-normal text-navy-950">
            <Smartphone size={18} strokeWidth={2} aria-hidden="true" />
            On a mobile
          </h4>
          <p className="m-0 text-[14px] leading-snug text-grey-700">Type each code into the phone&apos;s keypad and press call. It works on UK networks.</p>
          <ul aria-label="Divert codes" className="m-0 flex list-none flex-col gap-2 p-0">
            {mobile.codes.map((entry) => <DivertCode key={entry.key} label={entry.label} code={entry.code} />)}
          </ul>
          <p className="m-0 text-[13px] leading-snug text-grey-700">
            Or all three at once: <code className="font-mono text-[13px] text-navy-950">{mobile.allAtOnce}</code>. To stop diverting: <code className="font-mono text-[13px] text-navy-950">{mobile.cancel}</code>.
          </p>
        </section>
      ) : null}

      <section aria-labelledby="divert-landline" className="flex flex-col gap-2">
        <h4 id="divert-landline" className="m-0 flex items-center gap-2 font-sans text-[14px] font-bold tracking-normal text-navy-950">
          <PhoneForwarded size={18} strokeWidth={2} aria-hidden="true" />
          On a landline or office phone system
        </h4>
        <p className="m-0 text-[14px] leading-snug text-grey-700">{landlineDivertText(number)}</p>
      </section>

      <p className="m-0 text-[13px] leading-snug text-grey-700">
        Don&apos;t divert every call: your phone would stop ringing and every caller would go straight to the AI front desk.
      </p>
    </div>
  );
}

export type AiDeskNumberPanelProps = {
  number: AiDeskNumber | null;
  /** The owner's switch. */
  enabled: boolean;
  timeZone: string;
};

/** "Your AI desk number": its state, the number once ready and the divert instructions. */
export function AiDeskNumberPanel({ number, enabled, timeZone }: AiDeskNumberPanelProps) {
  const view = aiDeskNumberView(number, { enabled });
  const ready = number?.status === "ready" && number.number ? number.number : null;
  const style = STATE_STYLES[view.tone];
  const Icon = style.icon;
  const checked = when(number?.checkedAt ?? null, timeZone);

  return (
    <Panel id="number" title="Your AI desk number" actions={<Badge tone={view.tone}>{view.label}</Badge>}>
      {ready ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <a href={telHref(ready) ?? undefined} className={cn(textLinkClass, "font-display text-[30px] leading-none font-bold tracking-normal no-underline text-navy-950 hover:text-accent")}>
              {formatPhoneForDisplay(ready)}
            </a>
            <CopyButton value={formatPhoneForDisplay(ready)} label="Copy number" srSuffix={formatPhoneForDisplay(ready)} icon />
          </div>
          <p className="m-0 text-[14px] leading-snug text-grey-700">{view.detail}</p>
          {number?.ringsGarageFirst === true ? (
            <p className="m-0 text-[14px] leading-snug text-grey-700">Calls to this number ring your phone first, then go to the AI front desk if nobody answers. Don&apos;t divert your phone to it.</p>
          ) : (
            <ForwardingInstructions number={ready} />
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          <div role="status" className={cn("flex items-start gap-2.5 rounded-input p-3 text-[14px] leading-snug", style.box)}>
            <Icon size={20} strokeWidth={2} aria-hidden="true" className="mt-px shrink-0" />
            <p className="m-0">{view.detail}</p>
          </div>
          {number?.status === "failed" && number.reason ? (
            <p className="m-0 text-[13px] text-grey-700">
              Reference for Vitalos: <code className="font-mono text-[13px] text-navy-950">{number.reason}</code>
            </p>
          ) : null}
          {checked && number?.status !== "pending" ? <p className="m-0 text-[13px] text-grey-700">Last checked {checked}.</p> : null}
        </div>
      )}
    </Panel>
  );
}
