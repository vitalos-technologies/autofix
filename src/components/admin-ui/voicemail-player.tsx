"use client";

import { useState } from "react";
import { Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonClass } from "./styles";

export type VoicemailPlayerProps = {
  /** Same-origin link that streams the recording for staff (`/api/admin/calls/{id}/voicemail`). */
  href: string;
  seconds?: number | null;
  tone?: "light" | "navy";
  className?: string;
};

/** 42 → "0:42". */
export function formatVoicemailLength(seconds: number) {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * "Play voicemail": nothing is fetched until it is pressed (every play is audited server-side), then
 * a native audio player takes its place.
 */
export function VoicemailPlayer({ href, seconds, tone = "light", className }: VoicemailPlayerProps) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const navy = tone === "navy";
  const length = typeof seconds === "number" && seconds > 0 ? formatVoicemailLength(seconds) : null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={length ? `Play voicemail (${length})` : "Play voicemail"}
        className={buttonClass(navy ? "onDark" : "secondary", "sm", cn("self-start rounded-[11px] text-[14px]", className))}
      >
        <Play size={16} strokeWidth={2.2} aria-hidden="true" />
        Play voicemail
        {length ? <span className="font-normal">({length})</span> : null}
      </button>
    );
  }
  if (failed) {
    return (
      <p role="status" className={cn("m-0 text-[13px] font-semibold", navy ? "text-[#fca5a5]" : "text-[#991b1b]", className)}>
        The voicemail couldn&apos;t be played. Try again later.
      </p>
    );
  }
  return (
    // Voicemails are callers speaking: there is no transcript to caption them with yet.
    <audio controls autoPlay preload="none" src={href} onError={() => setFailed(true)} aria-label={`Voicemail${length ? `, ${length}` : ""}`} className={cn("h-11 w-full", className)} />
  );
}
