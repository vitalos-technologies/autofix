import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { focusRing } from "@/components/admin-ui/styles";

export const inputClass = cn(
  "block min-h-12 w-full rounded-input border border-grey-300 bg-white px-3.5 text-[16px] text-navy-950",
  "aria-invalid:border-[#b91c1c]",
  focusRing,
);

export type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "name"> & {
  id: string;
  name: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  /** Rendered before the input inside the same row, e.g. a fixed prefix. */
  suffix?: ReactNode;
};

/** Labelled input with hint and error wired to `aria-describedby`; 48px tall, 16px text (no zoom on iOS). */
export function TextField({ id, name, label, hint, error, suffix, className, ...input }: TextFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-[14px] font-semibold text-navy-950">
        {label}
      </label>
      {hint ? <p id={hintId} className="m-0 text-[13px] leading-5 text-grey-600">{hint}</p> : null}
      <div className="flex items-center gap-2">
        <input
          id={id}
          name={name}
          aria-invalid={error ? true : undefined}
          aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined}
          className={inputClass}
          {...input}
        />
        {suffix}
      </div>
      {error ? <p id={errorId} className="m-0 text-[13px] font-semibold text-[#b91c1c]">{error}</p> : null}
    </div>
  );
}

/** A status or error box. */
export function Notice({ tone = "info", children, id, role }: { tone?: "info" | "error" | "success" | "warning"; children: ReactNode; id?: string; role?: "alert" | "status" }) {
  const tones = {
    info: "border-[#bcd3f5] bg-info-bg text-info-ink",
    error: "border-[#f3c1c1] bg-[#fdecec] text-[#8f1d1d]",
    success: "border-[#bfe5cb] bg-success-bg text-success-ink",
    warning: "border-[#f1dc9f] bg-warning-bg text-warning-ink",
  } as const;
  return (
    <div id={id} role={role} className={cn("rounded-[12px] border p-3.5 text-[14px] leading-5 font-semibold", tones[tone])}>
      {children}
    </div>
  );
}
