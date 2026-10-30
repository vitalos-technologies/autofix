import { cn } from "@/lib/utils";
import { focusRing, focusRingOnDark } from "@/components/book/styles";

export { focusRing, focusRingOnDark };

export type ButtonVariant = "primary" | "secondary" | "success" | "ghost" | "onDark" | "onDarkPrimary";
export type ButtonSize = "md" | "sm";

/**
 * Admin buttons. Every size is at least 44px tall (design/DESIGN.md "Shape and spacing"); the 38px
 * buttons in the admin drawings are drawn at 44px here.
 *
 * `success` uses #15803d rather than the drawn #16a34a: white text on #16a34a is 3.3:1, under 4.5:1.
 */
const variants: Record<ButtonVariant, string> = {
  primary: cn("border-0 bg-accent font-bold text-accent-ink hover:bg-[color-mix(in_srgb,var(--garage-accent)_88%,black)]", focusRing),
  secondary: cn("border border-grey-300 bg-white font-semibold text-navy-950 hover:border-grey-600", focusRing),
  success: cn("border-0 bg-[#15803d] font-bold text-white hover:bg-[#166534]", focusRing),
  ghost: cn("border-0 bg-transparent font-semibold text-navy-950 hover:bg-grey-100", focusRing),
  onDark: cn("border border-[#3a5480] bg-transparent font-semibold text-white hover:bg-navy-900", focusRingOnDark),
  onDarkPrimary: cn("border-0 bg-accent font-bold text-accent-ink hover:bg-[color-mix(in_srgb,var(--garage-accent)_88%,black)]", focusRingOnDark),
};

const sizes: Record<ButtonSize, string> = {
  md: "min-h-11 rounded-input px-4 text-[14px]",
  sm: "min-h-11 rounded-[10px] px-3 text-[13.5px]",
};

/** Class names for an admin button or button-styled link. */
export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", className?: string) {
  return cn(
    "inline-flex items-center justify-center gap-2 text-center leading-tight no-underline transition-colors",
    "aria-disabled:cursor-not-allowed aria-disabled:opacity-60 disabled:cursor-not-allowed disabled:opacity-60",
    variants[variant],
    sizes[size],
    className,
  );
}

/** Underlined accent text link, at least 44px tall for touch. */
export const textLinkClass = cn(
  "inline-flex min-h-11 items-center font-semibold text-accent-text underline underline-offset-2 hover:text-blue-700",
  focusRing,
);

/** White card on the grey admin background. */
export const cardClass = "rounded-card border border-grey-200 bg-white";
