import { CalendarDays, Ellipsis, LayoutDashboard, Plus, UserRound, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCount } from "./format";
import { NavLink } from "./nav-link";
import { focusRing } from "./styles";

export type AdminTabItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  /** The raised accent "New" tab. */
  primary?: boolean;
  /** Extra words for screen readers after the label, e.g. "booking" → "New booking". */
  srSuffix?: string;
  badge?: number;
};

/**
 * The five phone tabs from design/screens/Admin-Today-Phone.dc.html. "More" goes to a page listing
 * every section (the sidebar groups), the garage switcher and the account menu.
 */
export const DEFAULT_ADMIN_TABS: AdminTabItem[] = [
  { label: "Today", href: "/app", icon: LayoutDashboard },
  { label: "Diary", href: "/app/diary", icon: CalendarDays },
  { label: "New", href: "/app/bookings/new", icon: Plus, primary: true, srSuffix: "booking" },
  { label: "Customers", href: "/app/customers", icon: UserRound },
  { label: "More", href: "/app/more", icon: Ellipsis },
];

/** Bottom padding for phone content above the fixed tab bar (includes the safe-area inset). */
export const adminTabBarPadding = "pb-[calc(96px+env(safe-area-inset-bottom))] lg:pb-10";

export type AdminTabBarProps = {
  tabs?: AdminTabItem[];
  /** Current path; the matching tab gets `aria-current="page"`. Omit it to follow the browser path. */
  activeHref?: string;
  /** Landmark name. Default "Main". */
  label?: string;
  /** Fixed to the bottom of the viewport on phones (default). `false` renders it in place. */
  fixed?: boolean;
  className?: string;
};

/** Phone navigation: five tabs fixed to the bottom, hidden from 1024px where the sidebar shows. */
export function AdminTabBar({ tabs = DEFAULT_ADMIN_TABS, activeHref, label = "Main", fixed = true, className }: AdminTabBarProps) {
  const hrefs = tabs.map((tab) => tab.href);

  return (
    <nav
      aria-label={label}
      className={cn(
        "border-t border-grey-200 bg-white px-1.5 pt-2 pb-[max(14px,env(safe-area-inset-bottom))] font-sans leading-[normal]",
        fixed && "fixed inset-x-0 bottom-0 z-40 lg:hidden",
        className,
      )}
    >
      <ul className="m-0 grid list-none p-0" style={{ gridTemplateColumns: `repeat(${Math.max(tabs.length, 1)}, minmax(0, 1fr))` }}>
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <li key={`${tab.label}-${tab.href}`} className="flex">
              <NavLink
                href={tab.href}
                hrefs={hrefs}
                activeHref={activeHref}
                className={cn("relative flex min-h-11 w-full flex-col items-center gap-1 rounded-[10px] py-1.5 text-[11px] no-underline", focusRing)}
                activeClassName="font-bold text-accent-text"
                inactiveClassName="font-semibold text-grey-600 hover:text-navy-950"
              >
                {tab.primary ? (
                  <span aria-hidden="true" className="-mt-0.5 flex h-[30px] w-11 items-center justify-center rounded-[10px] bg-accent text-accent-ink">
                    <Icon size={20} strokeWidth={2.4} />
                  </span>
                ) : (
                  <Icon size={22} strokeWidth={2} aria-hidden="true" />
                )}
                <span>
                  {tab.label}
                  {tab.srSuffix ? (
                    <>
                      {" "}
                      <span className="sr-only">{tab.srSuffix}</span>
                    </>
                  ) : null}
                </span>
                {tab.badge && tab.badge > 0 ? (
                  <span className="absolute top-0.5 left-[calc(50%+6px)] rounded-full bg-accent px-1.5 py-px text-[10.5px] font-bold text-accent-ink">
                    <span aria-hidden="true">{formatCount(tab.badge)}</span>
                    <span className="sr-only">, {tab.badge} new</span>
                  </span>
                ) : null}
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
