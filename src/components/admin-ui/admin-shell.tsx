import Link from "next/link";
import type { ReactNode } from "react";
import { Bell } from "lucide-react";
import { cn } from "@/lib/utils";
import { AccountMenu } from "./account-menu";
import { PitlineLogo } from "@/components/brand/pitline-logo";
import { AdminNavGroups } from "./admin-nav";
import { AdminSearch, DEFAULT_SEARCH_PLACEHOLDER } from "./admin-search";
import { AdminShellProvider } from "./admin-shell-context";
import { AdminTabBar, adminTabBarPadding, type AdminTabItem } from "./admin-tab-bar";
import { formatCount } from "./format";
import { GarageSwitcher } from "./garage-switcher";
import { focusRing, textLinkClass } from "./styles";
import type { AdminGarage, AdminLink, AdminNavGroup, AdminUser, FormAction } from "./types";

export type AdminShellProps = {
  /** Garages the member belongs to (switcher menu). */
  garages: AdminGarage[];
  currentGarageId: string;
  /** Posts `garageId`; see GarageSwitcher. */
  switchGarageAction?: FormAction;
  /** P5.9: "Group overview" link in the switcher when the selected garage is in a group. */
  groupOverviewHref?: string;
  /** Sidebar groups; `defaultAdminNav()` gives Workshop / Customers / Setup. */
  nav: AdminNavGroup[];
  /**
   * Current path, for `aria-current="page"` in the sidebar and tab bar. Omit it in a layout: the
   * links then follow the browser's path (layouts do not re-render on client navigation).
   */
  activeHref?: string;
  user: AdminUser;
  /** The garage's public booking page (opens in a new tab). */
  bookingPageUrl?: string | null;
  unreadCount?: number;
  notificationsHref?: string;
  /** Search form action (POST). The search box is hidden without it. */
  searchAction?: FormAction;
  searchPlaceholder?: string;
  signOutAction?: FormAction;
  /** Extra account menu links. */
  accountLinks?: AdminLink[];
  /** Phone tabs; DEFAULT_ADMIN_TABS when absent. */
  tabs?: AdminTabItem[];
  /**
   * Element for the content area. `main` (default) is the page's main landmark; use `div` only when
   * an outer layout already renders `<main>` (the root layout does not).
   */
  contentElement?: "main" | "div";
  /** Rendered once outside the content, e.g. a client component that refreshes counts. */
  extras?: ReactNode;
  children: ReactNode;
  className?: string;
};

function AdminLogo() {
  return (
    <div className="px-2.5 pt-1">
      <PitlineLogo variant="mono" title="Pitline" className="h-8" />
    </div>
  );
}

/**
 * The admin frame (design/screens/Admin-Dashboard.dc.html). From 1024px: a white sidebar (the Navy
 * monochrome Pitline logo, brand kit D23; garage switcher; nav groups) and a white top bar (search,
 * booking page link, bell, account menu).
 * Under 1024px: no sidebar or top bar; `AdminTabBar` is fixed to the bottom and each page's
 * `PageHeader` carries search and the account menu. The admin is Pitline-branded: only the garage
 * tiles in the switcher use garage colours.
 *
 * Server-compatible: no hooks here, so `nav` and `tabs` can hold lucide icon components.
 */
export function AdminShell({
  garages,
  currentGarageId,
  switchGarageAction,
  groupOverviewHref,
  nav,
  activeHref,
  user,
  bookingPageUrl,
  unreadCount = 0,
  notificationsHref = "/app/notifications",
  searchAction,
  searchPlaceholder = DEFAULT_SEARCH_PLACEHOLDER,
  signOutAction,
  accountLinks,
  tabs,
  contentElement = "main",
  extras,
  children,
  className,
}: AdminShellProps) {
  const Content = contentElement;
  return (
    <AdminShellProvider
      value={{ user, signOutAction, accountLinks, notificationsHref, unreadCount, bookingPageUrl, searchAction, searchPlaceholder }}
    >
      <div className={cn("min-h-dvh bg-grey-50 font-sans leading-[normal] text-grey-800 lg:grid lg:grid-cols-[232px_minmax(0,1fr)]", className)}>
        <a
          href="#admin-main"
          className={cn(
            "sr-only z-50 rounded-input bg-white px-4 py-3 font-semibold text-navy-950 focus:not-sr-only focus:fixed focus:top-3 focus:left-3",
            focusRing,
          )}
        >
          Skip to content
        </a>

        <div className="hidden border-r border-grey-200 bg-white text-grey-700 lg:block">
          {/* The whole sidebar is the Main navigation landmark: mark, garage switcher and sections. */}
          <nav aria-label="Main" className="sticky top-0 flex max-h-dvh flex-col gap-[22px] overflow-y-auto px-3.5 py-5">
            <AdminLogo />
            <GarageSwitcher garages={garages} currentGarageId={currentGarageId} switchGarageAction={switchGarageAction} groupHref={groupOverviewHref} tone="light" />
            <AdminNavGroups groups={nav} activeHref={activeHref} tone="sidebar" />
          </nav>
        </div>

        <div className="flex min-w-0 flex-col">
          <header className="hidden border-b border-grey-200 bg-white px-7 py-3 lg:flex lg:flex-wrap lg:items-center lg:gap-3">
            {searchAction ? (
              <AdminSearch id="admin-search" action={searchAction} placeholder={searchPlaceholder} className="max-w-[460px] flex-[1_1_280px]" />
            ) : null}
            <div className="ml-auto flex items-center gap-2.5">
              {bookingPageUrl ? (
                <a href={bookingPageUrl} target="_blank" rel="noopener noreferrer" className={cn(textLinkClass, "px-1 text-[14px]")}>
                  View booking page
                  {" "}
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              ) : null}
              <Link
                href={notificationsHref}
                aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
                className={cn(
                  "relative flex size-11 items-center justify-center rounded-[10px] border border-[#dbe3ec] bg-white text-grey-800 hover:border-grey-600",
                  focusRing,
                )}
              >
                <Bell size={18} strokeWidth={2} aria-hidden="true" />
                {unreadCount > 0 ? (
                  <span
                    aria-hidden="true"
                    className="absolute -top-1.5 -right-1.5 min-w-5 rounded-full border-2 border-white bg-accent px-1 text-center text-[11px] leading-4 font-bold text-accent-ink"
                  >
                    {formatCount(unreadCount)}
                  </span>
                ) : null}
              </Link>
              <AccountMenu user={user} signOutAction={signOutAction} links={accountLinks} size={36} />
            </div>
          </header>

          <Content
            id="admin-main"
            tabIndex={-1}
            className={cn("w-full max-w-[1240px] min-w-0 px-4 pt-4 outline-none lg:px-7 lg:pt-[26px]", adminTabBarPadding)}
          >
            {children}
          </Content>
        </div>

        <AdminTabBar tabs={tabs} activeHref={activeHref} />
        {extras}
      </div>
    </AdminShellProvider>
  );
}

