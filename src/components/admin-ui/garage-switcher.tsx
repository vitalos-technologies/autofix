"use client";

import Link from "next/link";
import { useRef } from "react";
import { Building2, Check, ChevronsUpDown } from "lucide-react";
import { accentForWhiteText, DEFAULT_ACCENT } from "@/lib/branding/accent";
import { garageInitials } from "@/components/book/format";
import { cn } from "@/lib/utils";
import { focusRing, focusRingOnDark } from "./styles";
import { SubmitButton } from "./submit-button";
import type { AdminGarage, FormAction } from "./types";
import { useDetailsDismiss } from "./use-details-dismiss";

/** Form field the switcher posts: the chosen `garages.id`. */
export const GARAGE_SWITCH_FIELD = "garageId";

function tileColour(accent: string | null | undefined) {
  try {
    return accentForWhiteText(accent ?? DEFAULT_ACCENT);
  } catch {
    return DEFAULT_ACCENT;
  }
}

function GarageTile({ garage, size = 28 }: { garage: AdminGarage; size?: 28 | 32 }) {
  return (
    <span
      aria-hidden="true"
      style={{ background: tileColour(garage.accent) }}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg font-display leading-none font-extrabold text-white",
        size === 28 ? "size-7 text-[14px]" : "size-8 text-[15px]",
      )}
    >
      {(garage.initials || garageInitials(garage.name)).slice(0, 3)}
    </span>
  );
}

export type GarageSwitcherProps = {
  garages: AdminGarage[];
  currentGarageId: string;
  /**
   * Where the switch is posted. Each garage is a submit button named `garageId` (GARAGE_SWITCH_FIELD),
   * so a server action or a POST route works before JavaScript loads. Without it (or with one
   * garage) the current garage is shown with no menu.
   */
  switchGarageAction?: FormAction;
  /** `navy` in the sidebar, `light` on the phone "More" page. */
  tone?: "navy" | "light";
  /** P5.9: when the member's garage is in a group, a "Group overview" link (`/app/group`) under the garages. */
  groupHref?: string;
  className?: string;
};

/** The garage name at the top of the sidebar; opens a menu of the member's other garages. */
export function GarageSwitcher({ garages, currentGarageId, switchGarageAction, tone = "navy", groupHref, className }: GarageSwitcherProps) {
  const details = useRef<HTMLDetailsElement>(null);
  useDetailsDismiss(details);
  const current = garages.find((garage) => garage.id === currentGarageId) ?? garages[0];
  if (!current) return null;
  const navy = tone === "navy";
  const canSwitch = Boolean(switchGarageAction) && garages.length > 1;

  const face = (
    <>
      <GarageTile garage={current} />
      <span className="flex min-w-0 grow flex-col text-left">
        <span className={cn("line-clamp-2 text-[13.5px] font-bold break-words", navy ? "text-white" : "text-navy-950")}>{current.name}</span>
        {current.plan ? <span className={cn("truncate text-[11.5px]", navy ? "text-[#9aa7b6]" : "text-grey-600")}>{current.plan}</span> : null}
      </span>
    </>
  );

  const boxClass = cn(
    "flex min-h-11 w-full items-center gap-2.5 rounded-input px-3 py-2.5 font-sans leading-[normal]",
    navy ? "border border-[#1f365c] bg-[#0f2140]" : "border border-grey-200 bg-white",
  );

  const groupLink = groupHref ? (
    <Link
      href={groupHref}
      className={cn(
        "flex min-h-11 w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-[13.5px] font-semibold no-underline",
        navy ? "text-white hover:bg-[#15294d]" : "text-navy-950 hover:bg-grey-100",
        navy ? focusRingOnDark : focusRing,
      )}
    >
      <Building2 size={18} strokeWidth={2} aria-hidden="true" className="shrink-0" />
      Group overview
    </Link>
  ) : null;

  if (!canSwitch) {
    if (!groupLink) {
      return (
        <div className={cn(boxClass, className)}>
          <span className="sr-only">Garage: </span>
          {face}
        </div>
      );
    }
    return (
      <div className={cn("flex flex-col gap-1", className)}>
        <div className={boxClass}>
          <span className="sr-only">Garage: </span>
          {face}
        </div>
        {groupLink}
      </div>
    );
  }

  const isUrl = typeof switchGarageAction === "string";

  return (
    <details ref={details} className={cn("group relative", className)}>
      <summary
        className={cn(
          boxClass,
          "cursor-pointer list-none [&::-webkit-details-marker]:hidden",
          navy ? "hover:bg-navy-900" : "hover:border-grey-300",
          navy ? focusRingOnDark : focusRing,
        )}
      >
        <span className="sr-only">Switch garage. Current: </span>
        {face}
        <ChevronsUpDown size={18} strokeWidth={2} aria-hidden="true" className={cn("shrink-0", navy ? "text-[#9aa7b6]" : "text-grey-600")} />
      </summary>
      <form
        method={isUrl ? "post" : undefined}
        action={switchGarageAction}
        className={cn(
          "absolute inset-x-0 top-full z-30 mt-2 flex flex-col gap-0.5 rounded-input p-1.5",
          navy ? "border border-navy-line bg-navy-900" : "border border-grey-300 bg-white",
        )}
      >
        <p className={cn("m-0 px-2 pt-1 pb-1.5 text-[11px] font-bold tracking-[0.1em] uppercase", navy ? "text-[#9aa7b6]" : "text-grey-600")}>
          Your garages
        </p>
        {garages.map((garage) => {
          const selected = garage.id === current.id;
          return (
            <SubmitButton
              key={garage.id}
              name={GARAGE_SWITCH_FIELD}
              value={garage.id}
              aria-current={selected ? "true" : undefined}
              className={cn(
                "flex min-h-11 w-full items-center gap-2.5 rounded-[10px] border-0 bg-transparent px-2 py-1.5 text-left text-[13.5px] font-semibold",
                navy ? "text-white hover:bg-[#15294d]" : "text-navy-950 hover:bg-grey-100",
                navy ? focusRingOnDark : focusRing,
              )}
            >
              <GarageTile garage={garage} />
              <span className="min-w-0 grow truncate">{garage.name}</span>
              {selected ? (
                <>
                  <Check size={18} strokeWidth={2} aria-hidden="true" className="shrink-0" />
                  <span className="sr-only">(current)</span>
                </>
              ) : null}
            </SubmitButton>
          );
        })}
        {groupLink ? <div className={cn("mt-1 border-t pt-1", navy ? "border-navy-line" : "border-grey-200")}>{groupLink}</div> : null}
      </form>
    </details>
  );
}
