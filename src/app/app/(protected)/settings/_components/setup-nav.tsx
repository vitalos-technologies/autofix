import Link from "next/link";
import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, Info } from "lucide-react";
import { focusRing } from "@/components/admin-ui";
import { cn } from "@/lib/utils";

export type SetupSection = "services" | "hours" | "resources" | "branding" | "booking-page";

export const SETUP_SECTIONS: ReadonlyArray<{ key: SetupSection; label: string; href: string }> = [
  { key: "services", label: "Services & prices", href: "/app/settings/services" },
  { key: "hours", label: "Opening hours", href: "/app/settings/hours" },
  { key: "resources", label: "Bays & vans", href: "/app/settings/resources" },
  { key: "branding", label: "Branding & MOT", href: "/app/settings/branding" },
  { key: "booking-page", label: "Booking page", href: "/app/settings/booking-page" },
];

/**
 * Links between the Setup pages. On phones it scrolls sideways inside its own box; the page
 * never does.
 */
export function SetupNav({ current }: { current: SetupSection }) {
  return (
    <nav aria-label="Setup pages" className="-mx-1 overflow-x-auto px-1 py-1">
      <ul className="m-0 flex w-max list-none gap-1 rounded-control border border-grey-200 bg-white p-1">
        {SETUP_SECTIONS.map((section) => {
          const active = section.key === current;
          return (
            <li key={section.key}>
              <Link
                href={section.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-11 items-center rounded-[10px] px-3.5 text-[14px] font-semibold whitespace-nowrap no-underline transition-colors",
                  active ? "bg-navy-950 text-white" : "text-grey-700 hover:bg-grey-100 hover:text-navy-950",
                  focusRing,
                )}
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** A one-line notice at the top of a setup page or panel. */
export function SetupNotice({ tone = "info", children, className }: { tone?: "info" | "success" | "warning" | "danger"; children: ReactNode; className?: string }) {
  const Icon = tone === "success" ? CircleCheck : tone === "info" ? Info : CircleAlert;
  return (
    <div
      role={tone === "danger" ? "alert" : tone === "success" ? "status" : undefined}
      className={cn(
        "flex items-start gap-2.5 rounded-input px-3.5 py-3 font-sans text-[14px] leading-snug",
        tone === "info" && "bg-info-bg text-info-ink",
        tone === "success" && "bg-success-bg font-semibold text-success-ink",
        tone === "warning" && "bg-warning-bg text-warning-ink",
        tone === "danger" && "bg-[#fdecec] font-semibold text-[#991b1b]",
        className,
      )}
    >
      <Icon size={18} strokeWidth={2} aria-hidden="true" className="mt-px shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** What a member who may not change this section sees above it. */
export function ReadOnlyNotice({ level }: { level: "manage" | "owner" }) {
  return (
    <SetupNotice>
      {level === "owner"
        ? "You can see these settings. Only the garage owner can change them."
        : "You can see these settings. Owners and managers can change them."}
    </SetupNotice>
  );
}

/** Flash messages from a row action's redirect (`?done=` / `?error=` codes, never free text). */
export function FlashMessage({ messages, done, error }: { messages: Record<string, string>; done?: string | string[]; error?: string | string[] }) {
  const errorKey = typeof error === "string" ? error : undefined;
  const doneKey = typeof done === "string" ? done : undefined;
  if (errorKey && messages[`error:${errorKey}`]) return <SetupNotice tone="danger">{messages[`error:${errorKey}`]}</SetupNotice>;
  if (doneKey && messages[`done:${doneKey}`]) return <SetupNotice tone="success">{messages[`done:${doneKey}`]}</SetupNotice>;
  return null;
}
