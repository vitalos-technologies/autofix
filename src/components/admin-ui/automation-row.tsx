import Link from "next/link";
import { cn } from "@/lib/utils";
import { ChannelBadge } from "./badge";
import { focusRing } from "./styles";
import { Switch } from "./switch";
import type { FormAction, ReminderChannel } from "./types";

export type AutomationRowProps = {
  /** e.g. "MOT due". */
  name: string;
  /** The rule in words, e.g. "28 days and 7 days before expiry". */
  description: string;
  channel: ReminderChannel;
  /** Template / rule editor. */
  editHref?: string;
  /** Link text for `editHref`. Default "Edit" ("View" for members who can only read). */
  editLabel?: string;
  enabled: boolean;
  /** Switch accessible name; default the name, e.g. "MOT due reminders". */
  switchLabel?: string;
  /**
   * Saves the new state: the form posts `ruleId` and `enabled` (`"true"` / `"false"`, the state
   * after the toggle). The switch then shows whatever `enabled` the page renders next.
   */
  toggleAction?: FormAction;
  ruleId?: string;
  /** More hidden fields for `toggleAction`'s form, e.g. `{ kind: "mot" }`. */
  fields?: Record<string, string>;
  /** Client alternative to `toggleAction`: called with the new state. */
  onToggle?: (enabled: boolean) => void;
  disabled?: boolean;
  /** Draws the divider under the row (all but the last). */
  divider?: boolean;
  className?: string;
};

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** One reminder automation: name, rule, channel, Edit and an on/off switch. */
export function AutomationRow({
  name,
  description,
  channel,
  editHref,
  editLabel = "Edit",
  enabled,
  switchLabel,
  toggleAction,
  ruleId,
  fields,
  onToggle,
  disabled = false,
  divider = true,
  className,
}: AutomationRowProps) {
  const descriptionId = `automation-${slug(ruleId ?? name)}-description`;
  const label = switchLabel ?? name;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3.5 gap-y-1.5 py-3 font-sans leading-[normal] sm:py-3.5",
        divider && "border-b border-[#eef2f6]",
        className,
      )}
    >
      <div className="flex min-w-0 flex-[1_1_240px] flex-col gap-[3px]">
        <span className="text-[15px] font-bold text-navy-950">{name}</span>
        <span id={descriptionId} className="text-[13px] leading-snug text-grey-600">
          {description}
        </span>
      </div>
      <div className="ml-auto flex items-center gap-3.5">
        <ChannelBadge channel={channel} />
        {editHref ? (
          <Link
            href={editHref}
            className={cn("inline-flex min-h-11 items-center px-1 text-[13px] font-semibold text-accent underline underline-offset-2 hover:text-blue-700", focusRing)}
          >
            <span aria-hidden="true">{editLabel}</span>
            <span className="sr-only">{`${editLabel} ${name}`}</span>
          </Link>
        ) : null}
        {toggleAction ? (
          <form method={typeof toggleAction === "string" ? "post" : undefined} action={toggleAction} className="flex">
            {ruleId ? <input type="hidden" name="ruleId" value={ruleId} /> : null}
            {Object.entries(fields ?? {}).map(([field, value]) => (
              <input key={field} type="hidden" name={field} value={value} />
            ))}
            <input type="hidden" name="enabled" value={String(!enabled)} />
            <Switch type="submit" label={label} checked={enabled} disabled={disabled} describedBy={descriptionId} />
          </form>
        ) : (
          <Switch label={label} checked={enabled} onCheckedChange={onToggle} disabled={disabled} describedBy={descriptionId} />
        )}
      </div>
    </div>
  );
}
