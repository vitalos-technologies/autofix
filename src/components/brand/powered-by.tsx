import { cn } from "@/lib/utils";
import { PitlineLogo } from "./pitline-logo";

/**
 * "Powered by" and the Pitline logo, under a garage's booking pages: the colour logo on light
 * backgrounds, the reversed one on Navy (brand kit, D22). Screen readers hear "Powered by Pitline".
 */
export function PoweredByPitline({ onDark = false, className }: { onDark?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center justify-center gap-1.5 text-[11px]", onDark ? "text-[#94a3b8]" : "text-grey-600", className)}>
      Powered by
      <PitlineLogo variant={onDark ? "reversed" : "primary"} title="Pitline" className="h-3.5" />
    </span>
  );
}
