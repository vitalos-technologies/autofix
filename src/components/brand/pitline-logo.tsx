import { cn } from "@/lib/utils";
import { PITLINE_LOCKUPS, PITLINE_MARK } from "./logo-geometry";

/**
 * The Pitline logo (brand kit, DECISIONS D23), drawn inline from design/brand/pitline/.
 * - `primary`: Electric Blue mark, orange triangle, Navy wordmark. Marketing, emails, "Powered by".
 * - `mono`: all Navy, for light backgrounds. The garage admin.
 * - `reversed`: white mark with the orange triangle kept, white wordmark, for Navy backgrounds.
 * Layouts: `horizontal` (mark left, wordmark right), `stacked` (mark above), `icon` (mark only).
 * Size it with a height class (e.g. `h-8`); the width follows. Pass `title` when the logo is the only
 * name for something (a link); otherwise it is decorative and hidden from assistive technology.
 */
export type PitlineLogoVariant = "primary" | "mono" | "reversed";
export type PitlineLogoLayout = "horizontal" | "stacked" | "icon";

const COLOURS: Record<PitlineLogoVariant, { letter: string; triangle: string; word: string }> = {
  primary: { letter: "#2563eb", triangle: "#f97316", word: "#0f2747" },
  mono: { letter: "#0f2747", triangle: "#0f2747", word: "#0f2747" },
  reversed: { letter: "#ffffff", triangle: "#f97316", word: "#ffffff" },
};

function Mark({ colours, x, y }: { colours: (typeof COLOURS)[PitlineLogoVariant]; x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <path fill={colours.letter} fillRule="evenodd" d={PITLINE_MARK.letter} />
      <path fill={colours.triangle} d={PITLINE_MARK.triangle} />
    </g>
  );
}

export function PitlineLogo({
  variant = "primary",
  layout = "horizontal",
  title,
  className,
}: {
  variant?: PitlineLogoVariant;
  layout?: PitlineLogoLayout;
  title?: string;
  className?: string;
}) {
  const colours = COLOURS[variant];
  const lockup = layout === "icon" ? null : PITLINE_LOCKUPS[layout];
  const width = lockup?.width ?? PITLINE_MARK.width;
  const height = lockup?.height ?? PITLINE_MARK.height;
  const a11y = title ? { role: "img", "aria-label": title } : { "aria-hidden": true };
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${width} ${height}`} className={cn("block w-auto shrink-0", className)} {...a11y}>
      {title ? <title>{title}</title> : null}
      <Mark colours={colours} x={lockup?.markX ?? PITLINE_MARK.x} y={lockup?.markY ?? PITLINE_MARK.y} />
      {lockup ? <path fill={colours.word} transform={`translate(${lockup.wordX} ${lockup.wordY})`} d={lockup.word} /> : null}
    </svg>
  );
}
