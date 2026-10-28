"use client";

import { Loader2, Lock } from "lucide-react";
import { useFormStatus } from "react-dom";
import { focusRing } from "@/components/book/styles";
import { cn } from "@/lib/utils";

/** The pay page's submit button: full width, 54px, garage accent, busy while the action runs. */
export function PayButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className={cn(
        "inline-flex h-[54px] w-full items-center justify-center gap-2 rounded-control bg-accent px-4 text-[16px] font-bold text-accent-ink",
        "hover:bg-[color-mix(in_srgb,var(--garage-accent)_88%,black)] disabled:opacity-70",
        focusRing,
      )}
    >
      {pending ? <Loader2 size={18} strokeWidth={2.2} className="animate-spin" aria-hidden="true" /> : <Lock size={18} strokeWidth={2.2} aria-hidden="true" />}
      {pending ? "Taking you to pay…" : label}
    </button>
  );
}
