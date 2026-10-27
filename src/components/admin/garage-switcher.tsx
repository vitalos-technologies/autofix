"use client";

import { Building2 } from "lucide-react";
import { useId } from "react";
import { switchGarage } from "@/lib/tenancy/switch-garage";
import { cn } from "@/lib/utils";

export type GarageSwitcherMembership = { garageId: string; name: string; role: string };

/**
 * Shows the selected garage and, for people who work for more than one, a
 * plain form to switch. The server checks membership before it sets the
 * `af_garage` cookie. The garage's own name is the only garage branding in the admin.
 */
export function GarageSwitcher({ garage, memberships, tone = "light", className }: {
  garage: { id: string; name: string };
  memberships: GarageSwitcherMembership[];
  tone?: "light" | "dark";
  className?: string;
}) {
  const selectId = useId();
  const dark = tone === "dark";
  if (memberships.length <= 1) {
    return (
      <p className={cn("flex min-w-0 items-center gap-2 text-sm font-bold", dark ? "text-white" : "text-[#071127]", className)}>
        <Building2 size={17} className={dark ? "text-[#8FA4BC]" : "text-[#586575]"} aria-hidden="true" />
        <span className="sr-only">Garage: </span>
        <span className="truncate">{garage.name}</span>
      </p>
    );
  }
  return (
    <form action={switchGarage} className={cn("flex min-w-0 items-center gap-2", className)}>
      <label htmlFor={selectId} className="sr-only">Garage</label>
      <Building2 size={17} className={cn("shrink-0", dark ? "text-[#8FA4BC]" : "text-[#586575]")} aria-hidden="true" />
      <select
        id={selectId}
        name="garageId"
        defaultValue={garage.id}
        className={cn(
          "h-11 min-w-0 max-w-[16rem] truncate rounded-xl border px-3 text-sm font-bold outline-none focus-visible:outline-2 focus-visible:outline-offset-2",
          dark ? "border-white/20 bg-[#0c1d3d] text-white focus-visible:outline-[#67B9FF]" : "border-[#D7E0E9] bg-white text-[#071127] focus-visible:outline-[#1974E2]",
        )}
      >
        {memberships.map((membership) => (
          <option key={membership.garageId} value={membership.garageId}>{membership.name}</option>
        ))}
      </select>
      <button
        type="submit"
        aria-label="Switch garage"
        className={cn(
          "h-11 shrink-0 rounded-xl px-3 text-sm font-bold focus-visible:outline-2 focus-visible:outline-offset-2",
          dark ? "border border-white/20 text-white hover:bg-white/[0.06] focus-visible:outline-[#67B9FF]" : "border border-[#D7E0E9] text-[#071127] hover:border-[#1974E2] hover:text-[#1974E2] focus-visible:outline-[#1974E2]",
        )}
      >
        Switch
      </button>
    </form>
  );
}
