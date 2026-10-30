"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button";
import { focusRing, focusRingOnDark } from "./styles";

export type EmbedKind = "button" | "redirect" | "embed";

export type EmbedTab = {
  kind: EmbedKind;
  label: string;
  /** Code shown and copied. */
  code: string;
  /** Language label above the code. */
  language: string;
  /** One line under the code. */
  hint: string;
};

export type EmbedSnippetProps = {
  /** Booking page address, e.g. `https://book.hartleyroadmotors.co.uk`. */
  bookingUrl: string;
  /** Button colour in the "Book online" snippet (the garage accent). */
  accent: string;
  /** For the iframe title, e.g. "Hartley Road Motors". */
  garageName?: string;
  /** Replace the generated tabs. */
  tabs?: EmbedTab[];
  /** Tab shown first. */
  defaultKind?: EmbedKind;
  className?: string;
};

function attribute(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** The three ways to put the booking page on a garage's own website. */
export function embedTabs({ bookingUrl, accent, garageName }: Pick<EmbedSnippetProps, "bookingUrl" | "accent" | "garageName">): EmbedTab[] {
  const url = attribute(bookingUrl.replace(/\/+$/, ""));
  return [
    {
      kind: "button",
      label: '"Book online" button',
      language: "HTML",
      code: `<a href="${url}"\n   style="background:${attribute(accent)};color:#fff;padding:12px 20px;border-radius:12px">\n  Book online\n</a>`,
      hint: "Works on Wix, Squarespace, WordPress and any site builder.",
    },
    {
      kind: "redirect",
      label: "/book redirect",
      language: "Redirect",
      code: `From:  /book\nTo:    ${url}\nType:  301 (permanent)`,
      hint: "Add this in your website's redirect settings (often called URL redirects or URL mappings), so yoursite/book opens the booking page.",
    },
    {
      kind: "embed",
      label: "Embed in a page",
      language: "HTML",
      code: `<iframe src="${url}"\n  title="Book online${garageName ? ` with ${attribute(garageName)}` : ""}"\n  style="width:100%;min-height:760px;border:0"\n  loading="lazy"></iframe>`,
      hint: "Paste into an HTML or embed block. The button link works better on phones.",
    },
  ];
}

/** Tabs (real tablist: arrows, Home, End) with a read-only code block and copy button for each. */
export function EmbedSnippet({ bookingUrl, accent, garageName, tabs, defaultKind = "button", className }: EmbedSnippetProps) {
  const items = tabs ?? embedTabs({ bookingUrl, accent, garageName });
  const [selected, setSelected] = useState<EmbedKind>(items.some((tab) => tab.kind === defaultKind) ? defaultKind : (items[0]?.kind ?? "button"));
  const baseId = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = items.find((tab) => tab.kind === selected) ?? items[0];
  if (!current) return null;

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % items.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    if (next === null) return;
    event.preventDefault();
    const tab = items[next];
    if (!tab) return;
    setSelected(tab.kind);
    tabRefs.current[next]?.focus();
  }

  return (
    <div className={cn("flex flex-col gap-3.5 font-sans leading-[normal]", className)}>
      <div role="tablist" aria-label="Ways to add it" className="flex flex-wrap gap-1.5">
        {items.map((tab, index) => {
          const active = tab.kind === current.kind;
          return (
            <button
              key={tab.kind}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              id={`${baseId}-tab-${tab.kind}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`${baseId}-panel-${tab.kind}`}
              tabIndex={active ? 0 : -1}
              onClick={() => setSelected(tab.kind)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                "inline-flex min-h-11 items-center rounded-[10px] px-3.5 text-[13.5px]",
                active ? "border border-navy-950 bg-navy-950 font-bold text-white" : "border border-grey-300 bg-white font-semibold text-grey-700 hover:border-grey-600",
                focusRing,
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {items.map((tab) => (
        <div
          key={tab.kind}
          id={`${baseId}-panel-${tab.kind}`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${tab.kind}`}
          hidden={tab.kind !== current.kind}
          className="flex flex-col gap-3.5"
        >
          <div className="flex min-w-0 flex-col overflow-hidden rounded-input bg-navy-950">
            <div className="flex items-center justify-between gap-3 border-b border-navy-line py-1 pr-1.5 pl-4">
              <span className="text-[12px] font-semibold tracking-[0.06em] text-[#94a3b8] uppercase">{tab.language}</span>
              <CopyButton value={tab.code} label="Copy" srSuffix={`${tab.label} code`} variant="onDark" size="sm" icon />
            </div>
            <pre
              tabIndex={0}
              role="region"
              aria-label={`${tab.label} code`}
              className={cn("m-0 overflow-x-auto px-4 py-3.5 font-mono text-[13px] leading-[1.6] font-medium text-[#d6e2f2]", focusRingOnDark, "focus-visible:-outline-offset-3")}
            >
              <code>{tab.code}</code>
            </pre>
          </div>
          <p className="m-0 text-[13.5px] text-grey-600">{tab.hint}</p>
        </div>
      ))}
    </div>
  );
}
