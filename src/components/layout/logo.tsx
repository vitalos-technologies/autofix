import Link from "next/link";
import { PitlineLogo, type PitlineLogoVariant } from "@/components/brand/pitline-logo";
import { cn } from "@/lib/utils";

/**
 * The Pitline logo as a home link. The admin and sign-in screens use the Navy monochrome logo
 * (brand kit, D22); the marketing page passes `primary`. `inverse` is the reversed logo for Navy
 * backgrounds. Garage logos appear only on customer screens.
 */
export function Logo({
  variant = "mono",
  inverse = false,
  compact = false,
  className,
}: {
  variant?: PitlineLogoVariant;
  inverse?: boolean;
  compact?: boolean;
  className?: string;
}) {
  return (
    <Link href="/app" className={cn("inline-flex shrink-0 items-center rounded-lg", className)} aria-label="Pitline home">
      <PitlineLogo variant={inverse ? "reversed" : variant} className={compact ? "h-7" : "h-9"} />
    </Link>
  );
}
