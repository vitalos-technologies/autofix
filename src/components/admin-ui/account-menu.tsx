"use client";

import Link from "next/link";
import { useRef } from "react";
import { Bell, ExternalLink, LogOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCount, personInitials } from "./format";
import { focusRing } from "./styles";
import { SubmitButton } from "./submit-button";
import type { AdminLink, AdminUser, FormAction } from "./types";
import { useDetailsDismiss } from "./use-details-dismiss";

export type AccountMenuProps = {
  user: AdminUser;
  /** Sign-out form action. The item is hidden without it. */
  signOutAction?: FormAction;
  /** Extra links, e.g. Team or Security. */
  links?: AdminLink[];
  /** Phone only: notifications and the booking page live in this menu (there is no top bar). */
  notificationsHref?: string;
  unreadCount?: number;
  bookingPageUrl?: string | null;
  /** Avatar circle size: 36 in the desktop top bar, 40 in the phone header (as drawn). */
  size?: 36 | 40;
  className?: string;
};

const itemClass = cn(
  "flex min-h-11 w-full items-center gap-2.5 rounded-[10px] border-0 bg-transparent px-2.5 text-left text-[14px] font-semibold text-navy-950 no-underline hover:bg-grey-100",
  focusRing,
);

/** Avatar button with the member's name, email and account actions. Built on `<details>`. */
export function AccountMenu({
  user,
  signOutAction,
  links = [],
  notificationsHref,
  unreadCount = 0,
  bookingPageUrl,
  size = 36,
  className,
}: AccountMenuProps) {
  const details = useRef<HTMLDetailsElement>(null);
  useDetailsDismiss(details);
  const initials = (user.initials || personInitials(user.name || user.email)).slice(0, 3);
  const hasUnread = Boolean(notificationsHref) && unreadCount > 0;

  return (
    <details ref={details} className={cn("relative shrink-0", className)}>
      <summary
        className={cn(
          "relative flex size-11 cursor-pointer list-none items-center justify-center rounded-full [&::-webkit-details-marker]:hidden",
          focusRing,
        )}
      >
        <span className="sr-only">
          Account menu for {user.name}
          {hasUnread ? `, ${unreadCount} unread notifications` : ""}
        </span>
        <span
          aria-hidden="true"
          className={cn(
            "flex items-center justify-center rounded-full bg-[#dbe7f6] text-[13px] font-bold text-navy-950",
            size === 36 ? "size-9" : "size-10",
          )}
        >
          {initials}
        </span>
        {hasUnread ? <span aria-hidden="true" className="absolute top-0.5 right-0.5 size-3 rounded-full border-2 border-white bg-danger" /> : null}
      </summary>
      <div className="absolute top-full right-0 z-30 mt-2 flex w-[min(280px,calc(100vw-32px))] flex-col gap-0.5 rounded-card border border-grey-300 bg-white p-2 font-sans leading-[normal]">
        <div className="flex flex-col gap-0.5 px-2.5 pt-1.5 pb-2.5">
          <span className="truncate text-[14px] font-bold text-navy-950">{user.name}</span>
          <span className="truncate text-[13px] text-grey-600">{user.email}</span>
        </div>
        {notificationsHref ? (
          <Link href={notificationsHref} className={itemClass}>
            <Bell size={18} strokeWidth={2} aria-hidden="true" />
            <span className="grow">Notifications</span>
            {unreadCount > 0 ? (
              <span className="rounded-full bg-accent px-[7px] py-[2px] text-[11px] font-bold text-accent-ink">
                <span aria-hidden="true">{formatCount(unreadCount)}</span>
                <span className="sr-only">, {unreadCount} unread</span>
              </span>
            ) : null}
          </Link>
        ) : null}
        {bookingPageUrl ? (
          <a href={bookingPageUrl} target="_blank" rel="noopener noreferrer" className={itemClass}>
            <ExternalLink size={18} strokeWidth={2} aria-hidden="true" />
            <span className="grow">View booking page</span>
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        ) : null}
        {links.map((link) => (
          <Link key={link.href} href={link.href} className={itemClass}>
            {link.label}
          </Link>
        ))}
        {signOutAction ? (
          <form
            method={typeof signOutAction === "string" ? "post" : undefined}
            action={signOutAction}
            className="mt-1 border-t border-grey-200 pt-1"
          >
            <SubmitButton className={itemClass}>
              <LogOut size={18} strokeWidth={2} aria-hidden="true" />
              Sign out
            </SubmitButton>
          </form>
        ) : null}
      </div>
    </details>
  );
}
