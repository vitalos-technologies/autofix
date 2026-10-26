import Link from "next/link";
import {
  Bell,
  CalendarDays,
  FileText,
  Globe,
  LayoutDashboard,
  List,
  MessageSquare,
  Settings,
  Tag,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCount } from "./format";
import { focusRing, focusRingOnDark } from "./styles";
import type { AdminNavGroup } from "./types";

/**
 * The admin sidebar as drawn in design/screens/Admin-Dashboard.dc.html: Workshop / Customers / Setup.
 * Routes from docs/autofix/ARCHITECTURE.md ("Admin pages on the admin host under /app").
 */
export function defaultAdminNav({ newBookings = 0 }: { newBookings?: number } = {}): AdminNavGroup[] {
  return [
    {
      label: "Workshop",
      items: [
        { label: "Today", href: "/app", icon: LayoutDashboard },
        { label: "Diary", href: "/app/diary", icon: CalendarDays },
        { label: "Bookings", href: "/app/bookings", icon: List, badge: newBookings },
        { label: "Quotes & invoices", href: "/app/invoices", icon: FileText },
      ],
    },
    {
      label: "Customers",
      items: [
        { label: "Customers & cars", href: "/app/customers", icon: Users },
        { label: "Reminders", href: "/app/reminders", icon: Bell },
        { label: "Messages & calls", href: "/app/messages", icon: MessageSquare },
      ],
    },
    {
      label: "Setup",
      items: [
        { label: "Services & prices", href: "/app/settings/services", icon: Tag },
        { label: "Booking page", href: "/app/settings/booking-page", icon: Globe },
        { label: "Settings", href: "/app/settings", icon: Settings },
      ],
    },
  ];
}

function trimSlash(path: string) {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** Path and query, without the hash or a trailing slash. */
function withoutHash(href: string) {
  const [beforeHash = href] = href.split("#");
  const [path = beforeHash, query] = beforeHash.split("?");
  return query === undefined ? trimSlash(path) : `${trimSlash(path)}?${query}`;
}

function pathOf(href: string) {
  return trimSlash(href.split(/[?#]/)[0] ?? href);
}

/**
 * The href among `hrefs` that `activeHref` belongs to: an exact match (then one that differs only
 * by `#hash`), otherwise the longest plain path it sits under (`/app/bookings/123` →
 * `/app/bookings`). Top-level hrefs (`/app`) only match exactly, so they do not light up for
 * every page.
 */
export function resolveActiveHref(hrefs: readonly string[], activeHref: string): string | null {
  const exact = hrefs.find((href) => href === activeHref);
  if (exact) return exact;
  const active = withoutHash(activeHref);
  const sameTarget = hrefs.find((href) => withoutHash(href) === active);
  if (sameTarget) return sameTarget;
  const activePath = pathOf(activeHref);
  let best: string | null = null;
  for (const href of hrefs) {
    if (href.includes("?")) continue;
    const path = pathOf(href);
    if (path.split("/").filter(Boolean).length < 2) continue;
    if (activePath.startsWith(`${path}/`) && (!best || path.length > pathOf(best).length)) best = href;
  }
  return best;
}

export type AdminNavGroupsProps = {
  groups: AdminNavGroup[];
  activeHref: string;
  /** `navy` for the desktop sidebar, `light` for the phone "More" page. */
  tone?: "navy" | "light";
  className?: string;
};

/** The three nav groups as lists of links. The current page gets `aria-current="page"`. */
export function AdminNavGroups({ groups, activeHref, tone = "navy", className }: AdminNavGroupsProps) {
  const current = resolveActiveHref(
    groups.flatMap((group) => group.items.map((item) => item.href)),
    activeHref,
  );
  const navy = tone === "navy";

  return (
    <div className={cn("flex flex-col gap-[22px]", className)}>
      {groups.map((group) => {
        const headingId = `admin-nav-${tone}-${group.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
        return (
          <div key={group.label} className="flex flex-col gap-0.5">
            <p
              id={headingId}
              className={cn(
                "m-0 px-2.5 pb-1.5 text-[11px] leading-[normal] font-bold tracking-[0.1em] uppercase",
                navy ? "text-[#7d8ca1]" : "text-grey-600",
              )}
            >
              {group.label}
            </p>
            <ul aria-labelledby={headingId} className="m-0 flex list-none flex-col gap-0.5 p-0">
              {group.items.map((item) => {
                const active = item.href === current;
                const Icon = item.icon;
                const badge = item.badge && item.badge > 0 ? item.badge : 0;
                return (
                  <li key={`${item.label}-${item.href}`}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex min-h-11 items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-[14px] leading-[normal] no-underline transition-colors",
                        navy ? focusRingOnDark : focusRing,
                        navy
                          ? active
                            ? "bg-white font-bold text-navy-950"
                            : "font-semibold text-[#c9d4e2] hover:bg-navy-900 hover:text-white"
                          : active
                            ? "bg-navy-950 font-bold text-white"
                            : "border border-grey-200 bg-white font-semibold text-navy-950 hover:border-grey-300",
                      )}
                    >
                      <Icon size={18} strokeWidth={2} aria-hidden="true" className="shrink-0" />
                      <span className="min-w-0 grow truncate">{item.label}</span>
                      {badge ? (
                        <span className="ml-auto rounded-full bg-accent px-[7px] py-[2px] text-[11px] font-bold text-accent-ink">
                          <span aria-hidden="true">{formatCount(badge)}</span>
                          <span className="sr-only">, {item.badgeLabel ?? `${badge} new`}</span>
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
