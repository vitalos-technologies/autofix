import Link from "next/link";
import type { ReactNode } from "react";
import { PlateChip } from "@/components/book/plate-chip";
import { formatRegistrationDisplay } from "@/components/book/plate-format";
import { cn } from "@/lib/utils";
import { DEFAULT_GARAGE_TIME_ZONE, formatTime } from "./format";
import { StatusPill } from "./status-pill";
import { buttonClass, focusRing, type ButtonVariant } from "./styles";
import { SubmitButton } from "./submit-button";
import type { BookingStatus, FormAction } from "./types";

export type JobCardAction =
  | { label: string; href: string; variant?: ButtonVariant; action?: never; fields?: never }
  | {
      label: string;
      /** Server action or POST URL. */
      action: FormAction;
      /** Hidden fields sent with the action; `bookingId` is added automatically. */
      fields?: Record<string, string>;
      variant?: ButtonVariant;
      href?: never;
    };

export type JobCardProps = {
  bookingId: string;
  startsAt: string | Date;
  timeZone?: string;
  /** Bay or van, e.g. "Bay 1". */
  resourceName?: string | null;
  registration: string;
  /** Model, e.g. "Focus". */
  vehicle?: string | null;
  service: string;
  /** After the service, e.g. "warning light" or "parts due 12:00". */
  detail?: string | null;
  status: BookingStatus;
  /** Booking detail page; the top of the card links to it. */
  href?: string;
  /** The car being worked on now: accent border and the action row. */
  active?: boolean;
  /** Buttons shown when active, e.g. Add photos / Send quote / Mark ready. */
  actions?: JobCardAction[];
  /** Replaces `actions` with your own buttons. */
  renderActions?: () => ReactNode;
  className?: string;
};

/** One car on the phone Today list: time and bay, plate and model, service, status. */
export function JobCard({
  bookingId,
  startsAt,
  timeZone = DEFAULT_GARAGE_TIME_ZONE,
  resourceName,
  registration,
  vehicle,
  service,
  detail,
  status,
  href,
  active = false,
  actions = [],
  renderActions,
  className,
}: JobCardProps) {
  const summary = (
    <>
      <span className="flex w-[50px] shrink-0 flex-col items-start">
        <span className="text-[15px] font-bold text-navy-950">{formatTime(startsAt, timeZone)}</span>
        {resourceName ? <span className="text-[11.5px] text-grey-600">{resourceName}</span> : null}
      </span>
      <span className="flex min-w-0 grow flex-col gap-[3px]">
        <span className="flex min-w-0 items-center gap-2">
          <PlateChip registration={registration} />
          {vehicle ? <span className="truncate text-[12.5px] text-grey-600">{vehicle}</span> : null}
        </span>
        <span className="truncate text-[13.5px] font-semibold text-grey-800">{detail ? `${service} · ${detail}` : service}</span>
      </span>
      <StatusPill status={status} compact />
    </>
  );

  const rowClass = "flex items-center gap-3";
  const actionContent = active ? (renderActions ? renderActions() : actions.length > 0 ? <JobCardActions bookingId={bookingId} actions={actions} registration={registration} /> : null) : null;

  return (
    <article
      className={cn(
        "flex flex-col gap-2.5 rounded-card bg-white px-3.5 py-3 font-sans leading-[normal]",
        active ? "border-2 border-accent" : "border border-grey-200",
        className,
      )}
    >
      {href ? (
        <Link href={href} className={cn(rowClass, "-m-1 rounded-[12px] p-1 text-inherit no-underline", focusRing)}>
          {summary}
        </Link>
      ) : (
        <div className={rowClass}>{summary}</div>
      )}
      {actionContent}
    </article>
  );
}

function JobCardActions({ bookingId, actions, registration }: { bookingId: string; actions: JobCardAction[]; registration: string }) {
  const target = (
    <>
      {" "}
      <span className="sr-only">for {formatRegistrationDisplay(registration)}</span>
    </>
  );
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${actions.length}, minmax(0, 1fr))` }}>
      {actions.map((item) => {
        const variant = item.variant ?? "secondary";
        const className = buttonClass(variant, "sm", "w-full px-1.5 text-[12.5px]");
        if (item.href !== undefined) {
          return (
            <Link key={item.label} href={item.href} className={className}>
              {item.label}
              {target}
            </Link>
          );
        }
        return (
          <form key={item.label} method={typeof item.action === "string" ? "post" : undefined} action={item.action} className="flex">
            <input type="hidden" name="bookingId" value={bookingId} />
            {Object.entries(item.fields ?? {}).map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))}
            <SubmitButton className={className}>
              {item.label}
              {target}
            </SubmitButton>
          </form>
        );
      })}
    </div>
  );
}
