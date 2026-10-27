import { Eye } from "lucide-react";
import { buttonClass } from "@/components/admin-ui/styles";
import { endImpersonationAction } from "@/lib/platform/actions";
import type { Impersonation } from "@/lib/platform/policy";

export type ImpersonationBannerProps = {
  impersonation: Pick<Impersonation, "garageName" | "expiresAt" | "reason">;
  /** Where the banner sits: inside the garage admin (`app`) or on /admin pages (`platform`). */
  surface?: "app" | "platform";
};

const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });

/**
 * Shown while a Vitalos platform admin views a garage as support (P4.5). Mount it at the top of the garage
 * admin layout when `getAdminContext().impersonation` is set; /admin pages render it themselves.
 * "End impersonation" posts endImpersonationAction (ends the session, clears the hint cookie, back to /admin).
 */
export function ImpersonationBanner({ impersonation, surface = "app" }: ImpersonationBannerProps) {
  const ends = timeFormat.format(new Date(impersonation.expiresAt));
  return (
    <section
      aria-label="Support session"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b-2 border-[#b45309] bg-[#fffbeb] px-4 py-2.5 font-sans text-[14px] leading-snug text-[#451a03] lg:px-6"
    >
      <Eye size={20} strokeWidth={2} aria-hidden="true" className="shrink-0 text-[#92400e]" />
      <p className="m-0 min-w-0 flex-[1_1_260px]">
        <strong className="font-bold">
          {surface === "app" ? "Viewing" : "You are viewing"} {impersonation.garageName} as Vitalos support.
        </strong>{" "}
        Read-only, logged in the garage&apos;s audit log. Ends at {ends}.
      </p>
      <form action={endImpersonationAction}>
        <button type="submit" className={buttonClass("secondary", "sm", "border-[#92400e] text-[#451a03]")}>
          End impersonation
        </button>
      </form>
    </section>
  );
}
