import Image from "next/image";
import Link from "next/link";
import { ChevronLeft, Phone } from "lucide-react";
import { cn } from "@/lib/utils";
import { garageInitials } from "./format";
import { focusRing, focusRingOnDark } from "./styles";

export type GarageHeaderBack = {
  /** Previous step. */
  href: string;
  /** Accessible name, e.g. "Back to vehicle". */
  label: string;
};

export type GarageHeaderProps = {
  /** Garage trading name. */
  name: string;
  /** Location and specialism on step 1; car and registration (or service) once known. */
  subtitle?: string | null;
  /** Square logo; the accent initials tile is shown when absent. */
  logoUrl?: string | null;
  /** E.164 phone number. Shown as a call button on the first step (when there is no back button). */
  phone?: string | null;
  /** Back button (steps 2 to 4). The logo tile moves to the right, as drawn. */
  back?: GarageHeaderBack | null;
  /** `bar` = navy header strip (the steps); `light` = no strip, navy text, for the white confirmation page. */
  tone?: "bar" | "light";
  className?: string;
};

const actionClass = {
  bar: cn(
    "flex size-[46px] shrink-0 items-center justify-center rounded-input border border-navy-line text-white transition-colors hover:bg-navy-900",
    focusRingOnDark,
  ),
  light: cn(
    "flex size-[46px] shrink-0 items-center justify-center rounded-input border border-grey-300 bg-white text-navy-950 transition-colors hover:bg-grey-100",
    focusRing,
  ),
} as const;

function GarageMark({ name, logoUrl, light = false }: { name: string; logoUrl?: string | null; light?: boolean }) {
  if (logoUrl) {
    return (
      <Image
        src={logoUrl}
        alt=""
        width={38}
        height={38}
        unoptimized
        className={cn("size-[38px] shrink-0 rounded-[10px] bg-white object-contain", light && "border border-grey-200")}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="flex size-[38px] shrink-0 items-center justify-center rounded-[10px] bg-accent font-display text-[19px] leading-none font-extrabold text-accent-ink"
    >
      {garageInitials(name)}
    </span>
  );
}

/** Navy bar at the top of every booking step: garage mark, name, subtitle and a call or back button. */
export function GarageHeader({ name, subtitle, logoUrl, phone, back, tone = "bar", className }: GarageHeaderProps) {
  const light = tone === "light";
  return (
    <header
      className={cn(
        "flex items-center gap-3 px-[18px] py-3.5 font-sans leading-[normal]",
        tone === "bar" ? "bg-navy-950" : "bg-transparent",
        className,
      )}
    >
      {back ? (
        <Link href={back.href} aria-label={back.label} className={actionClass[tone]}>
          <ChevronLeft size={20} strokeWidth={2} aria-hidden="true" />
        </Link>
      ) : (
        <GarageMark name={name} logoUrl={logoUrl} light={light} />
      )}
      <div className="flex min-w-0 grow flex-col gap-px">
        <p className={cn("m-0 truncate text-[15px] font-bold", light ? "text-navy-950" : "text-white")}>{name}</p>
        {subtitle ? <p className={cn("m-0 truncate text-[12px]", light ? "text-grey-600" : "text-[#9aa7b6]")}>{subtitle}</p> : null}
      </div>
      {back ? (
        <GarageMark name={name} logoUrl={logoUrl} light={light} />
      ) : phone ? (
        <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} aria-label={`Call ${name}`} className={actionClass[tone]}>
          <Phone size={19} strokeWidth={2} aria-hidden="true" />
        </a>
      ) : null}
    </header>
  );
}
