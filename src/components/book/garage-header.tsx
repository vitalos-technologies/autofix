import Image from "next/image";
import Link from "next/link";
import { ChevronLeft, MessageSquare, Phone } from "lucide-react";
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
  /** E.164 phone number. Shown as the Call button when there is no back button. */
  phone?: string | null;
  /** The garage's contact form (`/contact`). Shown as the Contact button, beside Call, when there is no back button. */
  contactHref?: string | null;
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

/** 46px labelled buttons (icon + word) on the right of the header. */
const labelledAction = "flex h-[46px] shrink-0 items-center justify-center gap-1.5 rounded-input px-2.5 text-[14px] font-bold no-underline transition-colors";

/** Contact: outlined, like the back button. */
const contactClass = {
  bar: cn(labelledAction, "border border-navy-line text-white hover:bg-navy-900", focusRingOnDark),
  light: cn(labelledAction, "border border-grey-300 bg-white text-navy-950 hover:bg-grey-100", focusRing),
} as const;

/** Call: solid garage accent with white text (the accent always passes 4.5:1 with white), the header's main action. */
const callClass = {
  bar: cn(labelledAction, "bg-accent text-accent-ink hover:bg-[color-mix(in_srgb,var(--garage-accent)_88%,black)]", focusRingOnDark),
  light: cn(labelledAction, "bg-accent text-accent-ink hover:bg-[color-mix(in_srgb,var(--garage-accent)_88%,black)]", focusRing),
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

/**
 * Navy bar at the top of every booking step: garage mark, name, subtitle, and either a back button or
 * the Contact and Call buttons side by side (Temitope, 29 Oct 2026: both labelled, Call in the accent).
 */
export function GarageHeader({ name, subtitle, logoUrl, phone, contactHref, back, tone = "bar", className }: GarageHeaderProps) {
  const light = tone === "light";
  const callHref = phone ? `tel:${phone.replace(/[^\d+]/g, "")}` : null;
  const actions = !back && (contactHref || callHref);
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
        {/* Two lines for the name when the Contact and Call buttons take the room on a phone. */}
        <p className={cn("m-0 text-[15px] font-bold", actions ? "line-clamp-2 leading-[1.2] break-words" : "truncate", light ? "text-navy-950" : "text-white")}>{name}</p>
        {subtitle ? <p className={cn("m-0 truncate text-[12px]", light ? "text-grey-600" : "text-[#9aa7b6]")}>{subtitle}</p> : null}
      </div>
      {back ? (
        <GarageMark name={name} logoUrl={logoUrl} light={light} />
      ) : actions ? (
        <div className="flex shrink-0 items-center gap-2">
          {contactHref ? (
            <Link href={contactHref} aria-label={`Contact ${name}`} className={contactClass[tone]}>
              <MessageSquare size={18} strokeWidth={2} aria-hidden="true" />
              Contact
            </Link>
          ) : null}
          {callHref ? (
            <a href={callHref} aria-label={`Call ${name}`} className={callClass[tone]}>
              <Phone size={18} strokeWidth={2} aria-hidden="true" />
              Call
            </a>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
