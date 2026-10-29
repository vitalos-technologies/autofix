import { cn } from "@/lib/utils";
import { formatDuration, formatServicePrice, type PriceMode } from "./format";
import { focusWithinRing } from "./styles";

export type ServiceOptionProps = {
  /** Radio group name (shared by every option in the list). */
  name: string;
  /** Service id. */
  value: string;
  /** Service name. */
  label: string;
  /** One-line description. */
  description?: string | null;
  /** Shown after the description, e.g. `1 hr`. */
  durationMinutes?: number | null;
  pricePence?: number | null;
  priceMode: PriceMode;
  /** False when the garage hides prices on its booking page: no price column at all. */
  showPrice?: boolean;
  /** Controlled selection. Leave unset and use `defaultChecked` for a plain form. */
  checked?: boolean;
  defaultChecked?: boolean;
  onSelect?: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  className?: string;
};

/** Radio card for one service: name, description · duration, and the price (`£x`, `From £x` or `Quote`) unless the garage hides prices. */
export function ServiceOption({
  name,
  value,
  label,
  description,
  durationMinutes,
  pricePence,
  priceMode,
  showPrice = true,
  checked,
  defaultChecked,
  onSelect,
  disabled,
  required,
  className,
}: ServiceOptionProps) {
  const detail = [description?.trim(), formatDuration(durationMinutes)].filter(Boolean).join(" · ");
  const controlled = checked !== undefined;
  return (
    <label
      className={cn(
        "flex min-h-11 cursor-pointer items-center gap-3 rounded-control border border-grey-200 bg-white px-[15px] py-[13px] font-sans leading-[normal]",
        "has-[:checked]:border-2 has-[:checked]:border-accent has-[:checked]:px-[14px] has-[:checked]:py-3",
        focusWithinRing,
        disabled && "cursor-not-allowed opacity-60",
        className,
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        {...(controlled ? { checked } : { defaultChecked })}
        onChange={(event) => {
          if (event.target.checked) onSelect?.(value);
        }}
        disabled={disabled}
        required={required}
        className="m-0 size-5 shrink-0 cursor-pointer accent-accent focus-visible:outline-none! disabled:cursor-not-allowed"
      />
      <span className="flex min-w-0 grow flex-col gap-0.5">
        <span className="text-[15px] font-bold text-navy-950">{label}</span>
        {detail ? <span className="text-[12.5px] text-grey-600">{detail}</span> : null}
      </span>
      {showPrice ? <span className="shrink-0 text-right text-[13px] font-semibold text-grey-700">{formatServicePrice(pricePence, priceMode)}</span> : null}
    </label>
  );
}
