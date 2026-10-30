import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  id: string;
  label: string;
  /** Lighter text after the label, e.g. "(for your receipt)". */
  labelNote?: ReactNode;
  /** Help under the field. */
  hint?: string;
  error?: string | null;
};

/** Labelled 50px text input in the booking style (Book 4). */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { id, label, labelNote, hint, error, className, ...inputProps },
  ref,
) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("flex flex-col gap-1.5 font-sans leading-[normal]", className)}>
      <label htmlFor={id} className="text-[14px] font-semibold text-grey-800">
        {label}
        {labelNote ? <span className="font-normal text-grey-600"> {labelNote}</span> : null}
      </label>
      <input
        ref={ref}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          "h-[50px] w-full min-w-0 rounded-input border bg-white px-3.5 text-[16px] text-navy-950 placeholder:text-[#475569]",
          "focus:ring-1 focus:outline-none focus-visible:outline-none",
          error ? "border-danger ring-1 ring-danger focus:ring-2 focus:ring-danger" : "border-grey-300 focus:border-accent focus:ring-accent",
        )}
        {...inputProps}
      />
      {hint ? (
        <p id={hintId} className="m-0 text-[13px] text-grey-600">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="m-0 text-[13px] font-semibold text-[#b91c1c]">
          {error}
        </p>
      ) : null}
    </div>
  );
});
