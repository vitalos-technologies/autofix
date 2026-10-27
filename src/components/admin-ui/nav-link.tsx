"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { resolveActiveHref } from "./active-href";

export type NavLinkProps = {
  href: string;
  /** Every href in the same menu, so only the best match lights up. */
  hrefs: readonly string[];
  /**
   * The current page. Omit it to follow the browser's path: the admin layout does not re-render on
   * client navigation, so the shell's links work out the current page themselves.
   */
  activeHref?: string;
  className?: string;
  activeClassName?: string;
  inactiveClassName?: string;
  children: ReactNode;
};

/** A nav link that marks itself `aria-current="page"` for the current page. */
export function NavLink({ href, hrefs, activeHref, className, activeClassName, inactiveClassName, children }: NavLinkProps) {
  const pathname = usePathname();
  const active = resolveActiveHref(hrefs, activeHref ?? pathname ?? "") === href;
  return (
    <Link href={href} aria-current={active ? "page" : undefined} className={cn(className, active ? activeClassName : inactiveClassName)}>
      {children}
    </Link>
  );
}
