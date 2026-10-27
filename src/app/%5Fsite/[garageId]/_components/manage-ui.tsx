import type { ReactNode } from "react";
import { PlateChip, formatSlotLabel, formatTime } from "@/components/book";
import { focusRing } from "@/components/book/styles";
import { lastDigits } from "@/lib/booking-flow/copy";
import type { ManageBookingView } from "@/lib/booking-flow/manage-view";
import { cn } from "@/lib/utils";

// Pieces shared by the manage booking pages (`/manage`, `/manage/reschedule`, `/manage/cancel`),
// in the booking pages' language: white 18px cards, 14px buttons, chips and plates as on Book 1–5.

/** 54px primary action (the garage accent). */
export const managePrimaryAction = cn(
  "flex h-[54px] w-full items-center justify-center gap-2 rounded-control bg-accent px-4 text-[16px] font-bold text-accent-ink no-underline transition-colors",
  "hover:bg-[color-mix(in_srgb,var(--garage-accent)_88%,black)]",
  focusRing,
);

/** 50px secondary action: white with a grey border. */
export const manageSecondaryAction = cn(
  "flex h-[50px] w-full items-center justify-center gap-2 rounded-control border-[1.5px] border-grey-300 bg-white px-3 text-[15px] font-bold text-navy-950 no-underline transition-colors",
  "hover:border-navy-950 hover:bg-grey-100",
  focusRing,
);

/** 50px WhatsApp action (green as on the confirmation page; white text is 5.0:1). */
export const manageWhatsappAction = cn(
  "flex h-[50px] w-full items-center justify-center gap-2 rounded-control bg-[#15803d] px-3 text-[15px] font-bold text-white no-underline transition-colors hover:bg-success-ink",
  focusRing,
);

/** Underlined 44px text link (Book another car, Look up another booking). */
export const manageTextLink = cn(
  "inline-flex min-h-11 items-center justify-center rounded-[6px] bg-transparent px-1 text-[14px] font-semibold text-accent underline underline-offset-2 hover:text-blue-700",
  focusRing,
);

type NoticeTone = "info" | "success" | "warning" | "neutral";

const noticeTones: Record<NoticeTone, string> = {
  info: "border-[#c9daf3] bg-info-bg text-info-ink",
  success: "border-[#bfe3cb] bg-success-bg text-success-ink",
  warning: "border-[#f0d9a1] bg-warning-bg text-warning-ink",
  neutral: "border-[#e0e7ef] bg-white text-grey-700",
};

/** Icon + message box. `role="status"` for messages that appear after a change. */
export function ManageNotice({
  tone,
  icon,
  title,
  children,
  live = false,
  className,
}: {
  tone: NoticeTone;
  icon: ReactNode;
  title?: string;
  children: ReactNode;
  live?: boolean;
  className?: string;
}) {
  return (
    <div
      role={live ? "status" : undefined}
      className={cn("flex items-start gap-3 rounded-control border p-3.5 font-sans leading-[1.45]", noticeTones[tone], className)}
    >
      <span aria-hidden="true" className="mt-px shrink-0">
        {icon}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5 text-[13.5px]">
        {title ? <p className="m-0 font-bold">{title}</p> : null}
        <div className="m-0">{children}</div>
      </div>
    </div>
  );
}

function Fact({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-[3px]", wide && "col-span-2")}>
      <dt className="text-[12px] text-grey-600">{label}</dt>
      <dd className="m-0 text-[15px] font-bold break-words text-navy-950">{children}</dd>
    </div>
  );
}

const subline = "block text-[13px] font-normal text-grey-600";

/** The booking: reference, when, service, car (plate), name with masked phone, where. */
export function ManageBookingCard({
  view,
  timeZone,
  where,
  whereDetail,
  className,
}: {
  view: ManageBookingView;
  timeZone: string;
  /** "Workshop" or "Mobile visit". */
  where: string;
  /** The garage's address, or the visit's postcode district. */
  whereDetail?: string | null;
  className?: string;
}) {
  const cancelled = view.state === "cancelled";
  return (
    <section
      aria-label="Booking details"
      className={cn("flex flex-col gap-3.5 rounded-hero border border-grey-200 bg-white p-[18px] font-sans leading-[normal] text-grey-800", className)}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] font-bold tracking-[0.06em] text-grey-600 uppercase">Booking ref</span>
        <span className="font-display text-[22px] font-bold tracking-[0.04em] text-navy-950">{view.reference}</span>
      </div>
      <div aria-hidden="true" className="h-px bg-grey-200" />
      <dl className="m-0 grid grid-cols-2 gap-x-3.5 gap-y-4">
        <Fact label="When">
          <span className={cn("block", cancelled && "line-through decoration-grey-600")}>{formatSlotLabel(view.startsAt, timeZone)}</span>
          {cancelled ? null : <span className={subline}>Ready around {formatTime(view.endsAt, timeZone)}</span>}
        </Fact>
        <Fact label="Service">{view.serviceName}</Fact>
        <Fact label="Car" wide>
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {view.registration ? <PlateChip registration={view.registration} /> : null}
            {view.vehicleName ? <span>{view.vehicleName}</span> : null}
          </span>
        </Fact>
        <Fact label="Name">
          <span className="block">{view.customerName || "Not given"}</span>
          {view.phoneHint ? (
            <span className={subline}>
              <span aria-hidden="true">{view.phoneHint}</span>
              <span className="sr-only">Mobile ending {lastDigits(view.phoneHint)}</span>
            </span>
          ) : null}
        </Fact>
        <Fact label="Where">
          <span className="block">{where}</span>
          {whereDetail ? <span className={subline}>{whereDetail}</span> : null}
        </Fact>
      </dl>
    </section>
  );
}
