import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { focusRing } from "./styles";

/**
 * Height of the fixed bar in px (with a one-line footnote), not counting the safe-area inset.
 * Pages give their content this much bottom padding; `stickyActionBarPadding` does it for you.
 */
export const STICKY_ACTION_BAR_HEIGHT = 124;

/** Bottom padding for page content under a fixed `StickyActionBar` (includes the safe-area inset). */
export const stickyActionBarPadding = "pb-[calc(124px+env(safe-area-inset-bottom))]";

type ActionProps =
  | { href: string; onClick?: never; type?: never; form?: never; disabled?: never }
  | { href?: undefined; onClick?: () => void; type?: "button" | "submit"; form?: string; disabled?: boolean };

export type StickyActionBarProps = ActionProps & {
  /** States the next step or the chosen time, e.g. "Choose a time" or "Tue 27 Oct, 09:15". */
  label: string;
  /** Show the trailing arrow (on for steps 1 to 3). */
  showArrow?: boolean;
  /** Shows a spinner and marks the button busy (button form only). */
  busy?: boolean;
  /** Small line under the button, e.g. "Powered by Autofix" or "Nothing to pay now." with a link. */
  footnote?: ReactNode;
  /** Fixed to the bottom of the viewport (default). `false` renders it in place (component gallery). */
  fixed?: boolean;
  /** `danger` for a destructive confirmation such as "Cancel booking" (red instead of the garage accent). */
  tone?: "accent" | "danger";
  className?: string;
};

const buttonBase = cn(
  "flex h-[54px] w-full items-center justify-center gap-2 rounded-control px-4 text-[16px] font-bold no-underline transition-colors",
  "disabled:cursor-not-allowed disabled:bg-grey-300 disabled:text-grey-700",
  focusRing,
);

const buttonTones = {
  accent: "bg-accent text-accent-ink hover:bg-[color-mix(in_srgb,var(--garage-accent)_88%,black)]",
  // #b91c1c with white is 6.5:1.
  danger: "bg-[#b91c1c] text-white hover:bg-[#991b1b]",
} as const;

/** White bar in the thumb zone with the 54px primary action. */
export function StickyActionBar(props: StickyActionBarProps) {
  const { label, showArrow = true, busy = false, footnote, fixed = true, tone = "accent", className } = props;
  const buttonClass = cn(buttonBase, buttonTones[tone]);
  const content = (
    <>
      {busy ? <LoaderCircle size={18} strokeWidth={2} aria-hidden="true" className="animate-spin" /> : null}
      <span className="truncate">{label}</span>
      {showArrow && !busy ? <ArrowRight size={18} strokeWidth={2} aria-hidden="true" /> : null}
    </>
  );

  return (
    <div
      className={cn(
        "border-t border-grey-200 bg-white px-5 pt-3.5 pb-[max(26px,calc(env(safe-area-inset-bottom)+12px))] font-sans leading-[normal]",
        fixed && "fixed inset-x-0 bottom-0 z-40",
        className,
      )}
    >
      <div className="mx-auto w-full max-w-[480px]">
        {props.href !== undefined ? (
          <Link href={props.href} className={buttonClass}>
            {content}
          </Link>
        ) : (
          <button
            type={props.type ?? "button"}
            form={props.form}
            onClick={props.onClick}
            disabled={props.disabled || busy}
            aria-busy={busy || undefined}
            className={buttonClass}
          >
            {content}
          </button>
        )}
        {footnote ? <div className="mt-2.5 text-center text-[11.5px] text-grey-600">{footnote}</div> : null}
      </div>
    </div>
  );
}
