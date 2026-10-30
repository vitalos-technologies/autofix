"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { cn } from "@/lib/utils";
import { focusRing } from "./styles";

export type SwitchProps = {
  /** Accessible name, e.g. "MOT due reminders". */
  label: string;
  /** Controlled state. Leave undefined and use `defaultChecked` for an uncontrolled switch. */
  checked?: boolean;
  defaultChecked?: boolean;
  /** Called with the new state when toggled (button mode). */
  onCheckedChange?: (checked: boolean) => void;
  /**
   * `button` (default) toggles in place. `submit` submits the surrounding form instead, for a server
   * action that saves the new state; the switch shows the saved state it is given.
   */
  type?: "button" | "submit";
  /** With `type="submit"`: field name and value sent with the form. */
  name?: string;
  value?: string;
  disabled?: boolean;
  id?: string;
  /** Extra description id(s) for `aria-describedby`. */
  describedBy?: string;
  className?: string;
};

/**
 * On/off switch: a real `<button role="switch">` with `aria-checked`. The visible track is 46×28
 * (as drawn) inside a 44px-tall touch target. The off track is #7d8ca1 (3.4:1 against white) rather
 * than the drawn #cbd5e1, so the control stays visible for low-vision users.
 */
export function Switch({
  label,
  checked,
  defaultChecked = false,
  onCheckedChange,
  type = "button",
  name,
  value,
  disabled = false,
  id,
  describedBy,
  className,
}: SwitchProps) {
  const [internal, setInternal] = useState(defaultChecked);
  const { pending } = useFormStatus();
  const on = checked ?? internal;
  const busy = type === "submit" && pending;

  return (
    <button
      id={id}
      type={type}
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-describedby={describedBy}
      aria-busy={busy || undefined}
      name={type === "submit" ? name : undefined}
      value={type === "submit" ? value : undefined}
      disabled={disabled}
      onClick={(event) => {
        if (busy) {
          event.preventDefault();
          return;
        }
        if (type === "submit") return;
        const next = !on;
        if (checked === undefined) setInternal(next);
        onCheckedChange?.(next);
      }}
      className={cn(
        "group inline-flex h-11 w-[52px] shrink-0 cursor-pointer items-center justify-center rounded-full bg-transparent p-0",
        "disabled:cursor-not-allowed disabled:opacity-50",
        focusRing,
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex h-7 w-[46px] items-center rounded-full p-[3px] transition-colors",
          on ? "justify-end bg-accent" : "justify-start bg-[#7d8ca1]",
          busy && "opacity-70",
        )}
      >
        <span className="size-[22px] rounded-full bg-white" />
      </span>
    </button>
  );
}
