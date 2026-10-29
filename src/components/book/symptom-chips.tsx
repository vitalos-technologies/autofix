"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { focusRing } from "./styles";

export type SymptomOption = {
  value: string;
  label: string;
};

export type SymptomChipsProps = {
  /** Symptoms the garage offers for the chosen service. */
  options: readonly SymptomOption[];
  /** Selected symptom values. */
  selected: readonly string[];
  onChange: (selected: string[]) => void;
  /** Group label; visually hidden unless `hideLabel` is false. */
  label?: string;
  hideLabel?: boolean;
  /** Free-text note. The "Add a note" chip is only shown when `onNoteChange` is given. */
  note?: string;
  onNoteChange?: (note: string) => void;
  /** Text of the chip that reveals the note. */
  addNoteLabel?: string;
  /** Label of the note field. */
  noteLabel?: string;
  notePlaceholder?: string;
  noteMaxLength?: number;
  className?: string;
};

const chipBase = cn(
  "inline-flex h-11 items-center gap-1.5 rounded-full border bg-white px-3.5 text-[13px] font-semibold transition-colors",
  focusRing,
);
const chipOff = "border-grey-300 text-grey-700 hover:border-grey-600";
const chipOn = "border-[1.5px] border-accent text-accent-text";

/** Toggle chips for symptoms (`aria-pressed`) plus an "Add a note" chip that reveals a text area. */
export function SymptomChips({
  options,
  selected,
  onChange,
  label = "What have you noticed?",
  hideLabel = true,
  note = "",
  onNoteChange,
  addNoteLabel = "Add a note",
  noteLabel = "Note for the garage",
  notePlaceholder = "For example: when it happens, any noises or warning lights",
  noteMaxLength = 500,
  className,
}: SymptomChipsProps) {
  const labelId = useId();
  const noteId = useId();
  const [noteOpen, setNoteOpen] = useState(() => note.trim().length > 0);
  const focusNoteOnOpen = useRef(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (noteOpen && focusNoteOnOpen.current) {
      focusNoteOnOpen.current = false;
      noteRef.current?.focus();
    }
  }, [noteOpen]);

  function toggle(value: string) {
    onChange(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  }

  return (
    <div className={cn("flex flex-col gap-2.5 font-sans leading-[normal]", className)}>
      <span id={labelId} className={cn("text-[14px] font-semibold text-grey-800", hideLabel && "sr-only")}>
        {label}
      </span>
      <div role="group" aria-labelledby={labelId} className="flex flex-wrap gap-2">
        {options.map((option) => {
          const pressed = selected.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={pressed}
              onClick={() => toggle(option.value)}
              className={cn(chipBase, pressed ? chipOn : chipOff)}
            >
              {option.label}
            </button>
          );
        })}
        {onNoteChange ? (
          <button
            type="button"
            aria-expanded={noteOpen}
            aria-controls={noteId}
            onClick={() => {
              const next = !noteOpen;
              focusNoteOnOpen.current = next;
              setNoteOpen(next);
            }}
            className={cn(chipBase, noteOpen ? chipOn : chipOff)}
          >
            <Plus size={18} strokeWidth={2} aria-hidden="true" className={cn("transition-transform", noteOpen && "rotate-45")} />
            {addNoteLabel}
          </button>
        ) : null}
      </div>
      {onNoteChange ? (
        <div id={noteId} hidden={!noteOpen} className="flex flex-col gap-1.5">
          <label htmlFor={`${noteId}-field`} className="text-[14px] font-semibold text-grey-800">
            {noteLabel}
          </label>
          <textarea
            ref={noteRef}
            id={`${noteId}-field`}
            value={note}
            onChange={(event) => onNoteChange(event.target.value)}
            placeholder={notePlaceholder}
            maxLength={noteMaxLength}
            rows={3}
            className={cn(
              "min-h-24 w-full resize-y rounded-input border border-grey-300 bg-white px-3.5 py-3 text-[16px] leading-normal text-navy-950 placeholder:text-[#475569]",
              focusRing,
            )}
          />
        </div>
      ) : null}
    </div>
  );
}
