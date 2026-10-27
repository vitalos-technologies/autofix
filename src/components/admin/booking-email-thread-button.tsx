"use client";

import { LoaderCircle, Mail } from "lucide-react";
import { useFormStatus } from "react-dom";
import { buttonClass } from "@/components/admin-ui/styles";

export function BookingEmailThreadButton({
  label,
  showLabel = false,
}: {
  label: string;
  showLabel?: boolean;
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      aria-label={showLabel ? undefined : pending ? "Opening email thread" : label}
      title={label}
      disabled={pending}
      className={buttonClass("secondary", "md", "disabled:cursor-wait")}
    >
      {pending
        ? <LoaderCircle className="animate-spin" size={18} aria-hidden="true" />
        : <Mail size={18} aria-hidden="true" />}
      {showLabel && <span>{pending ? "Opening email…" : "Email customer"}</span>}
    </button>
  );
}
