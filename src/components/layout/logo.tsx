import { Wrench } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * The Pitline wordmark for the admin and sign-in screens. The admin is
 * Pitline-branded; garage logos appear only on customer screens.
 */
export function Logo({ inverse = false, compact = false, className }: { inverse?: boolean; compact?: boolean; className?: string }) {
  return (
    <Link href="/app" className={cn("inline-flex shrink-0 items-center gap-2 rounded-lg", className)} aria-label="Pitline home">
      <span aria-hidden="true" className={cn("grid shrink-0 place-items-center rounded-lg bg-[#155fba] text-white", compact ? "size-8" : "size-10")}>
        <Wrench size={compact ? 17 : 21} strokeWidth={2.25} />
      </span>
      <span aria-hidden="true" className={cn("font-display font-extrabold leading-none tracking-tight", compact ? "text-2xl" : "text-[1.9rem]", inverse ? "text-white" : "text-[#071127]")}>
        Pitline
      </span>
    </Link>
  );
}
