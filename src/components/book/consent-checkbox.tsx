import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { focusWithinRing } from "./styles";

/** Consent copy when the garage does MOTs. Store the text shown with the consent record. */
export const REMINDER_CONSENT_COPY = "Remind me when the MOT and service are due. You can stop these any time.";

/** Consent copy when the garage has MOT switched off. */
export const REMINDER_CONSENT_COPY_NO_MOT = "Remind me when the service is due. You can stop these any time.";

export type ConsentCheckboxProps = {
  name?: string;
  value?: string;
  id?: string;
  /** Controlled state. Leave unset for a plain form field (unticked by default). */
  checked?: boolean;
  /** Uncontrolled start state. Always unticked unless the customer already opted in. */
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  /** Picks the default copy (MOT and service, or service only). */
  motEnabled?: boolean;
  /** Replaces the default copy. */
  children?: ReactNode;
  disabled?: boolean;
  className?: string;
};

/** Reminder consent: a real checkbox in a labelled card, never ticked for the customer. */
export function ConsentCheckbox({
  name,
  value = "yes",
  id,
  checked,
  defaultChecked = false,
  onCheckedChange,
  motEnabled = true,
  children,
  disabled,
  className,
}: ConsentCheckboxProps) {
  const controlled = checked !== undefined;
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-control border border-grey-200 bg-white px-3.5 py-3 font-sans leading-[normal]",
        focusWithinRing,
        disabled && "cursor-not-allowed opacity-60",
        className,
      )}
    >
      <input
        type="checkbox"
        id={id}
        name={name}
        value={value}
        {...(controlled ? { checked } : { defaultChecked })}
        onChange={(event) => onCheckedChange?.(event.target.checked)}
        disabled={disabled}
        className="m-0 mt-px size-5 shrink-0 cursor-pointer accent-accent focus-visible:outline-none!"
      />
      <span className="text-[13.5px] leading-[1.45] text-grey-700">
        {children ?? (motEnabled ? REMINDER_CONSENT_COPY : REMINDER_CONSENT_COPY_NO_MOT)}
      </span>
    </label>
  );
}
