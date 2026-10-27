"use client";

import { useState } from "react";
import { PlateChip } from "@/components/book";
import { AutomationRow, buttonClass, focusRing, Switch } from "@/components/admin-ui";
import { ACCENT_PALETTE, accentForWhiteText, garageAccentStyle } from "@/lib/branding/accent";
import { cn } from "@/lib/utils";

type Automation = {
  id: string;
  name: string;
  description: string;
  channel: "sms" | "whatsapp" | "email" | "customer";
  switchLabel: string;
  enabled: boolean;
};

const AUTOMATIONS: Automation[] = [
  {
    id: "mot",
    name: "MOT due",
    description: "28 days and 7 days before expiry · dates checked against DVSA nightly",
    channel: "sms",
    switchLabel: "MOT due reminders",
    enabled: true,
  },
  { id: "service", name: "Service due", description: "11 months after the last service", channel: "sms", switchLabel: "Service due reminders", enabled: true },
  {
    id: "missed",
    name: "Missed-call text-back",
    description: "Texts a booking link within a minute of an unanswered call",
    channel: "whatsapp",
    switchLabel: "Missed-call text-back",
    enabled: true,
  },
  { id: "review", name: "Review request", description: "The day after collection, asks for a Google review", channel: "sms", switchLabel: "Review requests", enabled: false },
];

/** Automations with client state (the page will use `toggleAction` with a server action). */
export function AutomationsDemo({ editHref }: { editHref: string }) {
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => Object.fromEntries(AUTOMATIONS.map((item) => [item.id, item.enabled])));
  return (
    <div className="flex flex-col">
      {AUTOMATIONS.map((item, index) => (
        <AutomationRow
          key={item.id}
          name={item.name}
          description={item.description}
          channel={item.channel}
          switchLabel={item.switchLabel}
          editHref={editHref}
          enabled={enabled[item.id] ?? false}
          onToggle={(next) => setEnabled((current) => ({ ...current, [item.id]: next }))}
          divider={index < AUTOMATIONS.length - 1}
        />
      ))}
    </div>
  );
}

/** A lone switch with a visible label, off by default. */
export function SwitchDemo() {
  const [on, setOn] = useState(false);
  return (
    <div className="flex items-center gap-3">
      <Switch id="demo-switch" label="Send booking confirmations by WhatsApp" checked={on} onCheckedChange={setOn} />
      <label htmlFor="demo-switch" className="text-[14px] text-grey-800">
        Send booking confirmations by WhatsApp ({on ? "on" : "off"})
      </label>
    </div>
  );
}

const SWATCH_NAMES: Record<string, string> = { "#155fba": "Blue", "#0f766e": "Teal", "#b9451a": "Orange", "#6d28d9": "Purple" };

/** "Your branding" aside of the Booking page screen (page markup for P4.3, not a library component). */
export function BrandingDemo({ garageName, initials }: { garageName: string; initials: string }) {
  const [accent, setAccent] = useState<string>(ACCENT_PALETTE[0]);
  const [mot, setMot] = useState(true);
  const tile = accentForWhiteText(accent);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span aria-hidden="true" style={{ background: tile }} className="flex size-14 items-center justify-center rounded-[14px] font-display text-[26px] font-extrabold text-white">
          {initials}
        </span>
        <button type="button" className={buttonClass("secondary", "sm")}>
          Upload logo
        </button>
      </div>
      <div className="flex flex-col gap-2">
        <span id="brand-colour-label" className="text-[14px] font-semibold text-grey-800">
          Brand colour
        </span>
        <div role="group" aria-labelledby="brand-colour-label" className="flex flex-wrap gap-2.5">
          {ACCENT_PALETTE.map((colour) => (
            <button
              key={colour}
              type="button"
              aria-label={SWATCH_NAMES[colour] ?? colour}
              aria-pressed={accent === colour}
              onClick={() => setAccent(colour)}
              style={{ background: colour }}
              className={cn(
                "size-11 rounded-full",
                accent === colour ? "border-[3px] border-white outline-2 outline-navy-950 outline-solid" : "border-0",
                focusRing,
              )}
            />
          ))}
          <button
            type="button"
            aria-label="Custom colour"
            className={cn("flex size-11 items-center justify-center rounded-full border border-dashed border-grey-600 bg-white text-[18px] text-grey-700", focusRing)}
          >
            +
          </button>
        </div>
      </div>
      <div style={garageAccentStyle(accent)} className="flex flex-col overflow-hidden rounded-hero border border-grey-200" aria-label="Booking page preview" role="img">
        <div className="flex items-center gap-2 bg-navy-950 px-3 py-2.5">
          <span className="flex size-6 items-center justify-center rounded-[7px] bg-accent font-display text-[12px] font-extrabold text-accent-ink">{initials}</span>
          <span className="text-[12.5px] font-bold text-white">{garageName}</span>
        </div>
        <div className="flex flex-col gap-2.5 bg-grey-50 px-3 py-3.5">
          <span className="font-display text-[22px] leading-none font-extrabold text-navy-950">What are we booking in?</span>
          <div className="flex h-10 items-center justify-center rounded-[7px] border-2 border-[#111827] bg-plate">
            <PlateChip registration="AB12CDE" className="bg-transparent text-[20px] tracking-[0.08em]" />
          </div>
          <div className="flex h-[38px] items-center justify-center rounded-[10px] bg-accent text-[13px] font-bold text-accent-ink">Continue</div>
        </div>
      </div>
      <label className="flex min-h-11 items-center gap-2.5 text-[13.5px] text-grey-700">
        <input type="checkbox" checked={mot} onChange={(event) => setMot(event.target.checked)} className="size-[18px] accent-accent" />
        Show MOT bookings and MOT reminders
      </label>
    </div>
  );
}
