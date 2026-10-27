import Image from "next/image";
import Link from "next/link";
import { ChevronLeft, Phone } from "lucide-react";
import { cn } from "@/lib/utils";
import { garageInitials } from "./format";
import { focusRingOnDark } from "./styles";

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
  /** `bar` = navy header strip; `plain` = no background, for the navy confirmation page. */
  tone?: "bar" | "plain";
  className?: string;
};

const actionClass = cn(
  "flex size-[46px] shrink-0 items-center justify-center rounded-input border border-navy-line text-white transition-colors hover:bg-navy-900",
  focusRingOnDark,
);

function GarageMark({ name, logoUrl }: { name: string; logoUrl?: string | null }) {
  if (logoUrl) {
    return (
      <Image
        src={logoUrl}
        alt=""
        width={38}
        height={38}
        unoptimized
        className="size-[38px] shrink-0 rounded-[10px] bg-white object-contain"
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
  return (
    <header
      className={cn(
        "flex items-center gap-3 px-[18px] py-3.5 font-sans leading-[normal]",
        tone === "bar" ? "bg-navy-950" : "bg-transparent",
        className,
      )}
    >
      {back ? (
        <Link href={back.href} aria-label={back.label} className={actionClass}>
          <ChevronLeft size={20} strokeWidth={2} aria-hidden="true" />
        </Link>
      ) : (
        <GarageMark name={name} logoUrl={logoUrl} />
      )}
      <div className="flex min-w-0 grow flex-col gap-px">
        <p className="m-0 truncate text-[15px] font-bold text-white">{name}</p>
        {subtitle ? <p className="m-0 truncate text-[12px] text-[#9aa7b6]">{subtitle}</p> : null}
      </div>
      {back ? (
        <GarageMark name={name} logoUrl={logoUrl} />
      ) : phone ? (
        <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} aria-label={`Call ${name}`} className={actionClass}>
          <Phone size={19} strokeWidth={2} aria-hidden="true" />
        </a>
      ) : null}
    </header>
  );
}
