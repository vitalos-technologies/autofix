import { CalendarPlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { focusRingOnDark } from "./styles";

export type ConfirmationCardProps = {
  /** Booking reference, e.g. the garage prefix and number. */
  reference: string;
  /** Formatted date and time (see `formatSlotLabel`). */
  when: string;
  /** Car and registration. */
  vehicle: string;
  service: string;
  /** Workshop and postcode district, or "Mobile visit, <district>". */
  location: string;
  /** `.ics` download for the booking. */
  calendarHref?: string | null;
  /** Manage booking link (signed). */
  manageHref?: string | null;
  /** `https://wa.me/...` link to the garage; hidden when the garage has no WhatsApp. */
  whatsappHref?: string | null;
  className?: string;
};

const actionBase = cn(
  "flex h-[50px] items-center justify-center gap-2 rounded-control px-3 text-center text-[14.5px] font-bold text-white no-underline transition-colors",
  focusRingOnDark,
);

/** White card on the navy confirmation page: reference, 2 × 2 facts and the follow-up actions. */
export function ConfirmationCard({
  reference,
  when,
  vehicle,
  service,
  location,
  calendarHref,
  manageHref,
  whatsappHref,
  className,
}: ConfirmationCardProps) {
  const facts = [
    { label: "When", value: when },
    { label: "Car", value: vehicle },
    { label: "Service", value: service },
    { label: "Where", value: location },
  ];
  const actionCount = (calendarHref ? 1 : 0) + (manageHref ? 1 : 0);

  return (
    <div className={cn("flex w-full flex-col gap-2.5 font-sans leading-[normal]", className)}>
      <div className="flex flex-col gap-3.5 rounded-hero bg-white p-[18px] text-left text-grey-800">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] font-bold tracking-[0.06em] text-grey-600 uppercase">Booking ref</span>
          <span className="font-display text-[22px] font-bold tracking-[0.04em] text-navy-950">{reference}</span>
        </div>
        <div aria-hidden="true" className="h-px bg-grey-200" />
        <dl className="m-0 grid grid-cols-2 gap-3.5">
          {facts.map((fact) => (
            <div key={fact.label} className="flex min-w-0 flex-col gap-[3px]">
              <dt className="text-[12px] text-grey-600">{fact.label}</dt>
              <dd className="m-0 text-[15px] font-bold break-words text-navy-950">{fact.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      {actionCount > 0 ? (
        <div className={cn("mt-3 grid gap-2.5", actionCount === 2 ? "grid-cols-2" : "grid-cols-1")}>
          {calendarHref ? (
            <a href={calendarHref} className={cn(actionBase, "bg-accent text-accent-ink hover:bg-[color-mix(in_srgb,var(--garage-accent)_88%,black)]")}>
              <CalendarPlus size={18} strokeWidth={2} aria-hidden="true" className="shrink-0" />
              Add to calendar
            </a>
          ) : null}
          {manageHref ? (
            <a href={manageHref} className={cn(actionBase, "border-[1.5px] border-[#3a5480] hover:bg-navy-900")}>
              Change or cancel
            </a>
          ) : null}
        </div>
      ) : null}
      {whatsappHref ? (
        <a
          href={whatsappHref}
          rel="noopener noreferrer"
          className={cn(actionBase, "mt-3 w-full bg-[#15803d] hover:bg-success-ink")}
        >
          Message the garage on WhatsApp
        </a>
      ) : null}
    </div>
  );
}
