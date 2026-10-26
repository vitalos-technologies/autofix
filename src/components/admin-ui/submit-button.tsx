"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type SubmitButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "formAction"> & {
  children: ReactNode;
  /** Overrides the form's action for this button (a URL, a server action or a client function). */
  formAction?: string | ((formData: FormData) => void | Promise<void>);
};

/**
 * Submit button that shows a spinner while its form's action runs and ignores repeat presses
 * (it stays focusable: `aria-disabled`, not `disabled`).
 */
export function SubmitButton({ children, className, formAction, onClick, ...props }: SubmitButtonProps) {
  const status = useFormStatus();
  const busy = status.pending;
  // Only the button that started the submission shows the spinner: matched by its own action,
  // or by its name/value in the submitted form data.
  const { name, value } = props;
  const mine =
    busy &&
    (typeof formAction === "function"
      ? status.action === formAction
      : name && value !== undefined && status.data
        ? status.data.get(name) === String(value)
        : true);

  return (
    <button
      {...props}
      type="submit"
      formAction={formAction}
      aria-disabled={busy || props["aria-disabled"] || undefined}
      onClick={(event) => {
        if (busy) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      className={cn(className)}
    >
      {mine ? <LoaderCircle size={18} strokeWidth={2} aria-hidden="true" className="animate-spin" /> : null}
      {children}
    </button>
  );
}
