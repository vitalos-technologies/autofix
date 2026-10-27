"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { buttonClass, type ButtonVariant } from "./styles";

export type CopyButtonProps = {
  /** Text put on the clipboard. */
  value: string;
  /** Visible label. Default "Copy". */
  label?: string;
  /** What is copied, for screen readers: "Copy" + " value cname.vercel-dns-0.com". */
  srSuffix?: string;
  variant?: ButtonVariant;
  size?: "md" | "sm";
  /** Show the copy icon before the label. */
  icon?: boolean;
  className?: string;
};

async function writeClipboard(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the selection fallback (insecure origins, denied permission).
  }
  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Copies a value and confirms with "Copied" (announced politely to screen readers). */
export function CopyButton({ value, label = "Copy", srSuffix, variant = "secondary", size = "md", icon = false, className }: CopyButtonProps) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    const ok = await writeClipboard(value);
    setState(ok ? "copied" : "failed");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 2000);
  }

  return (
    <>
      <button type="button" onClick={copy} className={buttonClass(variant, size, className)}>
        {state === "copied" ? (
          <Check size={18} strokeWidth={2} aria-hidden="true" />
        ) : icon ? (
          <Copy size={18} strokeWidth={2} aria-hidden="true" />
        ) : null}
        <span>{state === "copied" ? "Copied" : label}</span>
        {srSuffix && state !== "copied" ? (
          <>
            {" "}
            <span className="sr-only">{srSuffix}</span>
          </>
        ) : null}
      </button>
      <span role="status" className="sr-only">
        {state === "copied" ? "Copied to clipboard" : state === "failed" ? "Could not copy. Select the text and copy it instead." : ""}
      </span>
    </>
  );
}
