import {
  Bell,
  CalendarDays,
  Clock,
  FileText,
  Globe,
  Inbox,
  CreditCard,
  LayoutDashboard,
  List,
  Lock,
  MessageSquare,
  Palette,
  ScrollText,
  Settings,
  ShieldCheck,
  Tag,
  Truck,
  UserCog,
  Users,
} from "lucide-react";
import { ClipboardCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { resolveActiveHref } from "./active-href";
import { formatCount } from "./format";
import { NavLink } from "./nav-link";
import { focusRing, focusRingOnDark } from "./styles";
import type { AdminNavGroup, AdminNavItem } from "./types";

export { resolveActiveHref };

export type AdminNavOptions = {
  /** Bookings waiting for the garage's OK (badge on Bookings). */
  newBookings?: number;
  /** Screen reader text for that badge; default "{n} new". */
  newBookingsLabel?: string;
  /**
   * P5.2: Pro features the garage's plan doesn't include (`hasFeature()` from src/lib/plans), keyed by
   * feature. Their links stay in the nav with a "Pro" badge and open the locked upgrade card.
   */
  lockedFeatures?: ReadonlySet<string>;
};

/**
 * P5.2: the Grow group, one entry per shipped Pro feature with its own admin section (feature key,
 * label, route, icon). A Pro feature adds its line here when its route exists, so the shell never links
 * to a page that isn't built (tests/e2e/admin-pages.spec.ts visits every link).
 */
export const GROW_NAV_ITEMS: { feature: string; label: string; href: string; icon: AdminNavItem["icon"] }[] = [
  { feature: "health_checks", label: "Health checks", href: "/app/health-checks", icon: ClipboardCheck },
];

/** P5.2: Pro settings pages that live in Setup (feature key, label, route, icon). */
export const PRO_SETUP_NAV_ITEMS: { feature: string; label: string; href: string; icon: AdminNavItem["icon"] }[] = [];

function proItems(items: typeof GROW_NAV_ITEMS, locked: ReadonlySet<string> | undefined): AdminNavItem[] {
  return items.map(({ feature, ...item }) => ({ ...item, proLocked: locked?.has(feature) ?? false }));
}

/**
 * The admin sidebar: Workshop / Customers / Setup (design/screens/Admin-Dashboard.dc.html), with
 * every admin section from docs/autofix/ARCHITECTURE.md ("Admin pages on the admin host under
 * /app"). Setup pages land with P3.4/P4.3; their links are here already.
 */
export function defaultAdminNav({ newBookings = 0, newBookingsLabel, lockedFeatures }: AdminNavOptions = {}): AdminNavGroup[] {
  const grow = proItems(GROW_NAV_ITEMS, lockedFeatures);
  return [
    {
      label: "Workshop",
      items: [
        { label: "Today", href: "/app", icon: LayoutDashboard },
        { label: "Diary", href: "/app/diary", icon: CalendarDays },
        { label: "Bookings", href: "/app/bookings", icon: List, badge: newBookings, badgeLabel: newBookingsLabel },
        { label: "Quotes & invoices", href: "/app/invoices", icon: FileText },
        { label: "Enquiries", href: "/app/enquiries", icon: Inbox },
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
    ...(grow.length ? [{ label: "Grow", items: grow }] : []),
    {
      label: "Setup",
      items: [
        { label: "Services & prices", href: "/app/settings/services", icon: Tag },
        { label: "Opening hours", href: "/app/settings/hours", icon: Clock },
        { label: "Bays & vans", href: "/app/settings/resources", icon: Truck },
        { label: "Branding & MOT", href: "/app/settings/branding", icon: Palette },
        { label: "Booking page", href: "/app/settings/booking-page", icon: Globe },
        { label: "Team", href: "/app/settings/team", icon: UserCog },
        ...proItems(PRO_SETUP_NAV_ITEMS, lockedFeatures),
        { label: "Plan", href: "/app/settings/plan", icon: CreditCard },
        { label: "Agreements", href: "/app/settings/agreements", icon: ScrollText },
        { label: "Settings", href: "/app/settings", icon: Settings },
        { label: "Security", href: "/app/configuration/security", icon: ShieldCheck },
      ],
    },
  ];
}

export type AdminNavGroupsProps = {
  groups: AdminNavGroup[];
  /** Current path, for `aria-current="page"`. Omit it to follow the browser's path. */
  activeHref?: string;
  /** `navy` for the desktop sidebar, `light` for the phone "More" page. */
  tone?: "navy" | "light";
  className?: string;
};

/** The three nav groups as lists of links. The current page gets `aria-current="page"`. */
export function AdminNavGroups({ groups, activeHref, tone = "navy", className }: AdminNavGroupsProps) {
  const hrefs = groups.flatMap((group) => group.items.map((item) => item.href));
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
                const Icon = item.icon;
                const badge = item.badge && item.badge > 0 ? item.badge : 0;
                return (
                  <li key={`${item.label}-${item.href}`}>
                    <NavLink
                      href={item.href}
                      hrefs={hrefs}
                      activeHref={activeHref}
                      className={cn(
                        "flex min-h-11 items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-[14px] leading-[normal] no-underline transition-colors",
                        navy ? focusRingOnDark : focusRing,
                      )}
                      activeClassName={navy ? "bg-white font-bold text-navy-950" : "bg-navy-950 font-bold text-white"}
                      inactiveClassName={
                        navy
                          ? "font-semibold text-[#c9d4e2] hover:bg-navy-900 hover:text-white"
                          : "border border-grey-200 bg-white font-semibold text-navy-950 hover:border-grey-300"
                      }
                    >
                      <Icon size={18} strokeWidth={2} aria-hidden="true" className="shrink-0" />
                      <span className="min-w-0 grow truncate">{item.label}</span>
                      {item.proLocked ? (
                        <span
                          className={cn(
                            "ml-auto inline-flex items-center gap-1 rounded-full px-[7px] py-[2px] text-[11px] font-bold",
                            navy ? "bg-navy-900 text-[#c9d4e2]" : "bg-grey-100 text-navy-950",
                          )}
                        >
                          <Lock size={11} strokeWidth={2.4} aria-hidden="true" />
                          Pro
                          <span className="sr-only">, not on your plan</span>
                        </span>
                      ) : null}
                      {badge ? (
                        <span className="ml-auto rounded-full bg-accent px-[7px] py-[2px] text-[11px] font-bold text-accent-ink">
                          <span aria-hidden="true">{formatCount(badge)}</span>
                          <span className="sr-only">, {item.badgeLabel ?? `${badge} new`}</span>
                        </span>
                      ) : null}
                    </NavLink>
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
