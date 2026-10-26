import { cn } from "@/lib/utils";
import { formatRegistrationDisplay } from "./plate-format";

export type PlateChipProps = {
  /** Registration, stored form (`AB12CDE`) or spaced. */
  registration: string;
  /** `sm` for lists, `md` for the booking summary bar. */
  size?: "sm" | "md";
  className?: string;
};

const sizes = {
  sm: "rounded-[5px] px-1.5 py-0.5 text-[14px] tracking-[0.05em]",
  md: "rounded-md px-2 py-1 text-[17px] tracking-[0.06em]",
} as const;

/** Small yellow registration plate. */
export function PlateChip({ registration, size = "sm", className }: PlateChipProps) {
  return (
    <span
      className={cn(
        "inline-block shrink-0 bg-plate font-display leading-[normal] font-bold whitespace-nowrap text-plate-ink",
        sizes[size],
        className,
      )}
    >
      {formatRegistrationDisplay(registration)}
    </span>
  );
}
