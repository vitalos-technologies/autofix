import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { CircleAlert, CircleCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SetupFormState } from "@/lib/settings/setup";

// Form controls for the Setup pages, in the admin language (design/screens/Admin-Domain.dc.html:
// 46px inputs, 12px radius, #cbd5e1 border, 14px semibold labels). Server-compatible.

export const inputClass = cn(
  "h-[46px] w-full min-w-0 rounded-input border bg-white px-3.5 font-sans text-[15px] text-navy-950 placeholder:text-[#475569]",
  "focus-visible:border-2 focus-visible:border-accent focus-visible:outline-none",
  "disabled:cursor-not-allowed disabled:bg-grey-50 disabled:text-grey-700",
);

const borderClass = (error?: string | null) => (error ? "border-2 border-[#b91c1c]" : "border-grey-300");

export const labelClass = "text-[14px] font-semibold text-grey-800";
export const hintClass = "m-0 text-[13px] leading-snug text-grey-600";

export function describedBy(id: string, hint?: ReactNode, error?: string | null) {
  return [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
}

export function FieldError({ id, error }: { id: string; error?: string | null }) {
  if (!error) return null;
  return (
    <p id={`${id}-error`} className="m-0 text-[13px] font-semibold text-[#b91c1c]">
      {error}
    </p>
  );
}

export function FieldHint({ id, hint }: { id: string; hint?: ReactNode }) {
  if (!hint) return null;
  return (
    <p id={`${id}-hint`} className={hintClass}>
      {hint}
    </p>
  );
}

type FieldShellProps = {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  className?: string;
  children: ReactNode;
};

function FieldShell({ id, label, hint, error, className, children }: FieldShellProps) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5 font-sans leading-[normal]", className)}>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      {children}
      <FieldHint id={id} hint={hint} />
      <FieldError id={id} error={error} />
    </div>
  );
}

export type TextInputFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  /** Text inside the box before the value, e.g. "£". */
  prefix?: string;
  /** Text after the box, e.g. "minutes". */
  suffix?: string;
  /** A control (e.g. a submit button) on the input's own row, so the hint and error stay below both. */
  action?: ReactNode;
  fieldClassName?: string;
};

/** Labelled 46px input with hint and error. */
export function TextInputField({ id, label, hint, error, prefix, suffix, action, fieldClassName, className, ...input }: TextInputFieldProps) {
  const control = (
    <input
      id={id}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(id, hint, error)}
      className={cn(inputClass, borderClass(error), prefix && "pl-8", className)}
      {...input}
    />
  );
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} className={fieldClassName}>
      {prefix || suffix || action ? (
        <div className="flex items-center gap-2.5">
          <div className="relative min-w-0 grow">
            {prefix ? (
              <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-[15px] font-semibold text-grey-700">
                {prefix}
              </span>
            ) : null}
            {control}
          </div>
          {suffix ? <span className="shrink-0 text-[14px] text-grey-700">{suffix}</span> : null}
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : (
        control
      )}
    </FieldShell>
  );
}

export type TextAreaFieldProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> & {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  fieldClassName?: string;
};

export function TextAreaField({ id, label, hint, error, fieldClassName, className, ...textarea }: TextAreaFieldProps) {
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} className={fieldClassName}>
      <textarea
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={cn(inputClass, borderClass(error), "h-auto min-h-[92px] resize-y py-3 leading-normal", className)}
        {...textarea}
      />
    </FieldShell>
  );
}

export type SelectFieldProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> & {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  fieldClassName?: string;
  children: ReactNode;
};

export function SelectField({ id, label, hint, error, fieldClassName, className, children, ...select }: SelectFieldProps) {
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} className={fieldClassName}>
      <select
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={cn(inputClass, borderClass(error), "pr-9", className)}
        {...select}
      >
        {children}
      </select>
    </FieldShell>
  );
}

export type CheckboxFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "type"> & {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
};

/** A checkbox with its label and an optional line of explanation, 44px tall at least. */
export function CheckboxField({ id, label, hint, className, ...input }: CheckboxFieldProps) {
  return (
    <div className={cn("flex items-start gap-3 font-sans leading-[normal]", className)}>
      <span className="flex h-11 shrink-0 items-center">
        <input
          id={id}
          type="checkbox"
          aria-describedby={hint ? `${id}-hint` : undefined}
          className="m-0 size-5 cursor-pointer accent-accent disabled:cursor-not-allowed"
          {...input}
        />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5 py-[11px]">
        <label htmlFor={id} className="cursor-pointer text-[15px] font-semibold text-navy-950">
          {label}
        </label>
        <FieldHint id={id} hint={hint} />
      </span>
    </div>
  );
}

export type ChoiceOption<Value extends string> = { value: Value; label: string; hint?: string };

/**
 * A row of radio buttons drawn as a segmented control (real `<input type="radio">` in a fieldset).
 * Selected: navy, as the booking page's segmented control.
 */
export function ChoiceGroup<Value extends string>({
  name,
  legend,
  options,
  value,
  onChange,
  error,
  hint,
  id,
  disabled,
}: {
  name: string;
  legend: string;
  options: ReadonlyArray<ChoiceOption<Value>>;
  value: Value;
  onChange?: (value: Value) => void;
  error?: string | null;
  hint?: ReactNode;
  id: string;
  disabled?: boolean;
}) {
  return (
    <fieldset aria-describedby={describedBy(id, hint, error)} className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0 font-sans leading-[normal]">
      <legend className={cn(labelClass, "mb-1.5 p-0")}>{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              "flex min-h-11 cursor-pointer items-center gap-2 rounded-input border px-3.5 text-[14px] font-semibold",
              "has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-solid",
              value === option.value ? "border-navy-950 bg-navy-950 text-white" : "border-grey-300 bg-white text-navy-950 hover:border-grey-600",
              disabled && "cursor-not-allowed opacity-70",
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange?.(option.value)}
              disabled={disabled}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
      </div>
      <FieldHint id={id} hint={hint} />
      <FieldError id={id} error={error} />
    </fieldset>
  );
}

/** The result of the last save: a success note (polite) or what went wrong (alert). */
export function FormMessage({ state, className }: { state: Pick<SetupFormState, "status" | "message">; className?: string }) {
  if (state.status === "idle" || !state.message) return <div role="status" aria-live="polite" className="sr-only" />;
  const saved = state.status === "saved";
  return (
    <div
      role={saved ? "status" : "alert"}
      className={cn(
        "flex items-start gap-2 rounded-input px-3.5 py-3 font-sans text-[14px] leading-snug font-semibold",
        saved ? "bg-success-bg text-success-ink" : "bg-[#fdecec] text-[#991b1b]",
        className,
      )}
    >
      {saved ? <CircleCheck size={18} strokeWidth={2} aria-hidden="true" className="mt-px shrink-0" /> : <CircleAlert size={18} strokeWidth={2} aria-hidden="true" className="mt-px shrink-0" />}
      <span>{state.message}</span>
    </div>
  );
}
