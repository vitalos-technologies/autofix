"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { AccountMenu } from "./account-menu";
import { AdminSearch } from "./admin-search";
import { useAdminShell } from "./admin-shell-context";
import { focusRing } from "./styles";

export type PageHeaderProps = {
  /** Accent eyebrow above the title, e.g. "TUESDAY 27 OCTOBER" (shown upper case). */
  eyebrow?: ReactNode;
  /** Short eyebrow for phones, e.g. "TUE 27 OCT". Falls back to `eyebrow`. */
  phoneEyebrow?: ReactNode;
  title: ReactNode;
  /** Shorter title for phones, e.g. "Today" for "Morning, Dan. 9 cars in today." */
  phoneTitle?: ReactNode;
  description?: ReactNode;
  /** Buttons on the right (desktop) or under the title (phone). */
  actions?: ReactNode;
  /** Extra content inside the header, e.g. the phone summary chips. */
  children?: ReactNode;
  className?: string;
};

/**
 * Admin page title: Barlow 40px H1 (32px on phones) with an optional eyebrow, description and actions.
 *
 * Under 1024px it is the white band at the top of the screen (design/screens/Admin-Today-Phone.dc.html)
 * and, inside `AdminShell`, carries the search button and account menu, since phones have no top bar.
 * Start every admin page with it.
 */
export function PageHeader({ eyebrow, phoneEyebrow, title, phoneTitle, description, actions, children, className }: PageHeaderProps) {
  const shell = useAdminShell();
  const [searching, setSearching] = useState(false);
  const searchId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Server-action forms carry hidden inputs, so target the search box itself.
    if (searching) panelRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
  }, [searching]);

  const shortEyebrow = phoneEyebrow ?? eyebrow;
  const hasPhoneTitle = phoneTitle !== undefined;
  const hasPhoneEyebrow = phoneEyebrow !== undefined;

  return (
    <header
      className={cn(
        // The shell pads its content by 16px on phones; the white band sits flush against the top edge.
        "-mx-4 -mt-4 flex flex-col gap-3.5 border-b border-grey-200 bg-white px-[18px] pt-4 pb-3.5 font-sans leading-[normal]",
        "lg:mx-0 lg:mt-0 lg:border-0 lg:bg-transparent lg:p-0",
        className,
      )}
    >
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        {/* Phones: title and the account buttons share the first row; the description runs full width under them. */}
        <div className="grid min-w-0 flex-[1_1_300px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 lg:flex lg:flex-col lg:items-stretch lg:gap-1">
          <div className="col-start-1 row-start-1 flex min-w-0 flex-col gap-0.5 lg:gap-1">
            {eyebrow || shortEyebrow ? (
              <p className="m-0 text-[12px] font-bold tracking-[0.08em] text-accent uppercase lg:tracking-[0.1em]">
                {hasPhoneEyebrow ? (
                  <>
                    <span className="lg:hidden">{shortEyebrow}</span>
                    <span className="hidden lg:inline">{eyebrow}</span>
                  </>
                ) : (
                  eyebrow
                )}
              </p>
            ) : null}
            <h1 className="m-0 font-display text-[32px] leading-none font-extrabold tracking-[-0.01em] text-navy-950 lg:text-[40px]">
              {hasPhoneTitle ? (
                <>
                  <span className="lg:hidden">{phoneTitle}</span>
                  <span className="hidden lg:inline">{title}</span>
                </>
              ) : (
                title
              )}
            </h1>
          </div>
          {description ? (
            <div className="col-span-2 row-start-2 m-0 max-w-[560px] text-[15px] leading-normal text-grey-600 lg:mt-1">{description}</div>
          ) : null}
          {shell ? (
            <div className="col-start-2 row-start-1 flex shrink-0 items-center gap-2.5 lg:hidden">
              {shell.searchAction ? (
                <button
                  ref={toggleRef}
                  type="button"
                  aria-expanded={searching}
                  aria-controls={`${searchId}-panel`}
                  aria-label={searching ? "Close search" : "Search"}
                  onClick={() => setSearching((open) => !open)}
                  className={cn("flex size-11 items-center justify-center rounded-input border border-[#dbe3ec] bg-white text-grey-800", focusRing)}
                >
                  {searching ? <X size={20} strokeWidth={2} aria-hidden="true" /> : <Search size={20} strokeWidth={2} aria-hidden="true" />}
                </button>
              ) : null}
              <AccountMenu
                user={shell.user}
                signOutAction={shell.signOutAction}
                links={shell.accountLinks}
                notificationsHref={shell.notificationsHref}
                unreadCount={shell.unreadCount}
                bookingPageUrl={shell.bookingPageUrl}
                size={40}
              />
            </div>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2.5">{actions}</div> : null}
      </div>
      {shell?.searchAction ? (
        <div
          ref={panelRef}
          id={`${searchId}-panel`}
          hidden={!searching}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setSearching(false);
              toggleRef.current?.focus();
            }
          }}
          className="lg:hidden"
        >
          <AdminSearch id={`${searchId}-input`} action={shell.searchAction} placeholder={shell.searchPlaceholder} />
        </div>
      ) : null}
      {children}
    </header>
  );
}
