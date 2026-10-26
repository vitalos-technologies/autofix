"use client";

import { useId, useLayoutEffect, useRef, type ChangeEvent, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { caretAfterFormatting, formatPlateInput } from "./plate-format";

export type PlateInputProps = {
  /** Controlled value (as displayed, e.g. `AB12 CDE`). Keep it in React state or the signed booking cookie, never the URL. */
  value: string;
  /** Receives the formatted value: upper case, spaced for current-format plates. */
  onChange: (value: string) => void;
  /** Visible label. */
  label?: string;
  /** Hide the label visually (it is still read out). */
  hideLabel?: boolean;
  id?: string;
  /**
   * Form field name. Leave unset unless the form posts (server action or `method="post"`):
   * a GET form would put the registration in the URL.
   */
  name?: string;
  placeholder?: string;
  /** Help text under the plate. */
  hint?: string;
  /** Error message; marks the field invalid. */
  error?: string | null;
  disabled?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  /** Called on Enter, e.g. to look the car up. */
  onEnter?: () => void;
  className?: string;
};

/** Yellow UK rear-plate registration input with the blue UK band. */
export function PlateInput({
  value,
  onChange,
  label = "Registration",
  hideLabel = false,
  id,
  name,
  placeholder = "ENTER REG",
  hint,
  error,
  disabled,
  required,
  autoFocus,
  onEnter,
  className,
}: PlateInputProps) {
  const generatedId = useId();
  const inputId = id ?? `plate-${generatedId}`;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);

  useLayoutEffect(() => {
    const input = inputRef.current;
    const caret = pendingCaret.current;
    pendingCaret.current = null;
    if (!input || caret === null || document.activeElement !== input) return;
    input.setSelectionRange(caret, caret);
  }, [value]);

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const raw = event.target.value;
    const formatted = formatPlateInput(raw);
    const caret = event.target.selectionStart;
    pendingCaret.current = formatted !== raw && caret !== null ? caretAfterFormatting(raw, caret, formatted) : null;
    onChange(formatted);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && onEnter) {
      event.preventDefault();
      onEnter();
    }
  }

  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cn("flex flex-col gap-2 font-sans leading-[normal]", className)}>
      <label htmlFor={inputId} className={cn("text-[14px] font-semibold text-grey-800", hideLabel && "sr-only")}>
        {label}
      </label>
      <div
        className={cn(
          "flex h-[70px] overflow-hidden rounded-plate border-2",
          "focus-within:outline-3 focus-within:outline-solid focus-within:outline-offset-2 focus-within:outline-accent",
          disabled
            ? "border-grey-300 bg-[#f7e9a8]"
            : cn("bg-plate shadow-[0_6px_18px_rgba(7,17,39,0.12)]", error ? "border-danger" : "border-[#111827]"),
        )}
      >
        <span
          aria-hidden="true"
          className="flex w-[46px] shrink-0 flex-col items-center justify-end bg-plate-band pb-[9px] text-[13px] font-bold text-white"
        >
          UK
        </span>
        <input
          ref={inputRef}
          id={inputId}
          name={name}
          type="text"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          inputMode="text"
          enterKeyHint="search"
          disabled={disabled}
          required={required}
          autoFocus={autoFocus}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className="h-full w-full min-w-0 grow border-0 bg-transparent px-2 text-center font-display text-[36px] font-bold tracking-[0.08em] text-plate-ink uppercase outline-none placeholder:text-[#5c4d00] focus-visible:outline-none! disabled:cursor-not-allowed"
        />
      </div>
      {hint ? (
        <p id={hintId} className="m-0 text-[13px] text-grey-600">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="m-0 text-[13px] font-semibold text-[#b91c1c]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
