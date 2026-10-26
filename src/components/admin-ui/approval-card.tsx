import Link from "next/link";
import { PlateChip } from "@/components/book/plate-chip";
import { formatRegistrationDisplay } from "@/components/book/plate-format";
import { cn } from "@/lib/utils";
import { DEFAULT_GARAGE_TIME_ZONE, formatDayAndTime, formatTime, zonedMoment } from "./format";
import { buttonClass } from "./styles";
import { SubmitButton } from "./submit-button";
import type { BookingSource, FormAction } from "./types";

/** Where the booking came from, as a line next to the plate. */
export const SOURCE_LABELS: Record<BookingSource, string> = {
  online: "Booked online",
  missed_call: "From missed call",
  ai_agent: "Booked by AI agent",
  reminder: "From a reminder",
  phone: "Phone booking",
  walk_in: "Walk-in",
};

/** Eyebrow on the navy phone card. */
export const SOURCE_EYEBROWS: Record<BookingSource, string> = {
  online: "New online booking",
  missed_call: "Missed call",
  ai_agent: "New AI agent booking",
  reminder: "Booked from a reminder",
  phone: "New phone booking",
  walk_in: "New walk-in",
};

export type ApprovalSecondary =
  | { label?: string; action: FormAction; href?: never }
  | { label?: string; href: string; action?: never };

export type ApprovalCardProps = {
  /** Sent as the hidden `bookingId` field with both actions. */
  bookingId: string;
  registration: string;
  source: BookingSource;
  /** When the request came in; shown as "08:12" today, "21:40 last night", or "Mon 26, 21:40". */
  receivedAt?: string | Date;
  /** Needed with `receivedAt` to word it relative to today. */
  now?: string | Date;
  /** Overrides the worded received time. */
  receivedLabel?: string;
  customerName: string;
  /** Make and model, e.g. "Ford Focus" (navy phone card). */
  vehicle?: string;
  service: string;
  /** e.g. "Won't start". */
  detail?: string;
  /** Requested start; shown as "Wed 28, 09:15". */
  startsAt?: string | Date;
  timeZone?: string;
  /** Accept the booking (server action or POST URL). */
  acceptAction: FormAction;
  /** Second button: "Offer another time" (an action) or "Call back" (a `tel:` link). */
  secondary?: ApprovalSecondary;
  /** `light` in the "Needs your OK" panel, `navy` for the phone Today highlight. */
  tone?: "light" | "navy";
  className?: string;
};

/**
 * Worded time a request came in: "08:12" today, "21:40 last night" (yesterday from 18:00),
 * otherwise "Mon 26, 21:40". Garage time zone.
 */
export function formatReceived(receivedAt: string | Date, now: string | Date, timeZone = DEFAULT_GARAGE_TIME_ZONE): string {
  const received = zonedMoment(receivedAt, timeZone);
  const today = zonedMoment(now, timeZone);
  if (!received || !today) return "";
  if (received.dateKey === today.dateKey) return formatTime(receivedAt, timeZone);
  const yesterday = zonedMoment(new Date(new Date(now).getTime() - 24 * 60 * 60 * 1000), timeZone);
  if (yesterday && received.dateKey === yesterday.dateKey && received.minutes >= 18 * 60) return `${formatTime(receivedAt, timeZone)} last night`;
  return formatDayAndTime(receivedAt, timeZone);
}

/** A booking waiting for the garage's OK: plate, source, who and what, Accept and a second action. */
export function ApprovalCard({
  bookingId,
  registration,
  source,
  receivedAt,
  now,
  receivedLabel,
  customerName,
  vehicle,
  service,
  detail,
  startsAt,
  timeZone = DEFAULT_GARAGE_TIME_ZONE,
  acceptAction,
  secondary,
  tone = "light",
  className,
}: ApprovalCardProps) {
  const navy = tone === "navy";
  const plate = formatRegistrationDisplay(registration);
  const received = receivedLabel ?? (receivedAt && now ? formatReceived(receivedAt, now, timeZone) : receivedAt ? formatTime(receivedAt, timeZone) : "");
  const when = startsAt ? formatDayAndTime(startsAt, timeZone) : "";
  const secondaryLabel = secondary?.label ?? (source === "missed_call" ? "Call back" : navy ? "Other time" : "Offer another time");
  const target = (
    <>
      {" "}
      <span className="sr-only">
        for {plate}, {customerName}
      </span>
    </>
  );

  const facts = navy
    ? [vehicle ? `${vehicle} ${plate}` : plate, service, detail, when]
    : [service, detail, when];
  const factLine = facts.filter(Boolean).join(" · ");

  const size = "sm" as const;
  const primary = buttonClass(navy ? "onDarkPrimary" : "primary", size, "flex-1 rounded-[11px] text-[14px]");
  const second = buttonClass(navy ? "onDark" : "secondary", size, "flex-1 rounded-[11px] text-[14px]");
  const acceptIsUrl = typeof acceptAction === "string";

  return (
    <article
      className={cn(
        "flex flex-col gap-2.5 font-sans leading-[normal]",
        navy ? "rounded-card bg-navy-950 p-3.5 text-white" : "text-grey-800",
        className,
      )}
    >
      {navy ? (
        <p className="m-0 flex items-center gap-2">
          <span aria-hidden="true" className="size-2 rounded-full bg-plate" />
          <span className="text-[12px] font-bold tracking-[0.06em] text-[#f6d55c] uppercase">{SOURCE_EYEBROWS[source]}</span>
          {received ? <span className="text-[12px] text-[#b8c4d4]">· {received}</span> : null}
        </p>
      ) : (
        <p className="m-0 flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <PlateChip registration={registration} className="px-[7px] text-[15px]" />
          <span className="text-[12px] text-grey-600">{[SOURCE_LABELS[source], received].filter(Boolean).join(" · ")}</span>
        </p>
      )}
      <p className={cn("m-0", navy ? "text-[14.5px] leading-[1.4]" : "text-[14px] leading-[1.35]")}>
        <strong>{customerName}</strong>
        {factLine ? ` · ${factLine}` : null}
      </p>
      <form method={acceptIsUrl ? "post" : undefined} action={acceptAction} className="flex gap-2">
        <input type="hidden" name="bookingId" value={bookingId} />
        <SubmitButton name="intent" value="accept" className={primary}>
          Accept
          {target}
        </SubmitButton>
        {secondary?.href !== undefined ? (
          secondary.href.startsWith("/") ? (
            <Link href={secondary.href} className={second}>
              {secondaryLabel}
              {target}
            </Link>
          ) : (
            <a href={secondary.href} className={second}>
              {secondaryLabel}
              {target}
            </a>
          )
        ) : secondary?.action !== undefined ? (
          // No name/value here: React uses a server-action button's name to encode the action.
          <SubmitButton
            formAction={secondary.action}
            formMethod={typeof secondary.action === "string" ? "post" : undefined}
            className={second}
          >
            {secondaryLabel}
            {target}
          </SubmitButton>
        ) : null}
      </form>
    </article>
  );
}
