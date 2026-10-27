import type { ReactNode } from "react";
import { Phone } from "lucide-react";
import { GarageHeader, StepProgress, stickyActionBarPadding, type GarageHeaderBack } from "@/components/book";
import { formatPhoneForDisplay, telHref } from "@/lib/tenancy/contact";
import type { Garage } from "@/lib/tenancy/garage";
import { cn } from "@/lib/utils";

/** Column of the booking flow on tablets and desktops: the phone layout, centred; its 480px content lines up with the action bar button. */
export const BOOKING_COLUMN = "mx-auto w-full max-w-[520px]";

type BookingScreenProps = {
  garage: Pick<Garage, "name" | "logoUrl" | "phone">;
  /** 1 to 4; omitted for pages outside the steps. */
  step?: number;
  subtitle?: string | null;
  back?: GarageHeaderBack | null;
  /** Leave room for the fixed action bar (on for the steps). */
  withActionBar?: boolean;
  children: ReactNode;
};

/** Booking page frame: navy garage header, step progress and the step content. */
export function BookingScreen({ garage, step, subtitle, back, withActionBar = true, children }: BookingScreenProps) {
  return (
    <div className="flex min-h-dvh flex-col bg-grey-50 font-sans text-grey-800">
      <div className="bg-navy-950">
        <GarageHeader
          className={BOOKING_COLUMN}
          name={garage.name}
          subtitle={subtitle}
          logoUrl={garage.logoUrl}
          phone={back ? null : garage.phone}
          back={back}
        />
      </div>
      <div className={cn(BOOKING_COLUMN, "flex grow flex-col", withActionBar && stickyActionBarPadding)}>
        {step ? <StepProgress step={step} className="px-5 pt-4" /> : null}
        {children}
      </div>
    </div>
  );
}

/** Shown when services or times cannot be loaded: the customer can still phone the garage. */
export function BookingUnavailable({ garage, title = "Online booking isn't available right now" }: { garage: Pick<Garage, "name" | "phone">; title?: string }) {
  const href = telHref(garage.phone);
  return (
    <div className="flex flex-col gap-3 px-5 pt-5">
      <h1 className="m-0 font-display text-[34px] leading-[0.98] font-extrabold text-navy-950">{title}</h1>
      <p className="m-0 text-[15px] leading-normal text-grey-600">
        Please try again in a few minutes{href ? `, or call ${garage.name} and we'll book you in.` : "."}
      </p>
      {href ? (
        <a
          href={href}
          className="mt-2 inline-flex h-[54px] items-center justify-center gap-2 rounded-control bg-accent px-4 text-[16px] font-bold text-accent-ink no-underline"
        >
          <Phone size={18} strokeWidth={2} aria-hidden="true" />
          Call {formatPhoneForDisplay(garage.phone)}
        </a>
      ) : null}
    </div>
  );
}

/** Form-level message (errors from the step's server action). */
export function FormAlert({ children, id, className }: { children: ReactNode; id?: string; className?: string }) {
  return (
    <div
      id={id}
      role="alert"
      className={cn("rounded-control border border-[#f3c4c4] bg-[#fdecec] px-3.5 py-3 text-[13.5px] leading-[1.45] font-semibold text-[#991b1b]", className)}
    >
      {children}
    </div>
  );
}
