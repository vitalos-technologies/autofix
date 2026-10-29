"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut } from "lucide-react";
import { buttonClass, focusRingOnDark } from "@/components/admin-ui/styles";
import { signOutPlatformAction } from "@/lib/platform/actions";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/admin", label: "Garages", match: (path: string) => path === "/admin" || path.startsWith("/admin/garages") },
  { href: "/admin/jobs", label: "Job health", match: (path: string) => path.startsWith("/admin/jobs") },
];

/** Navy top bar for /admin: product name, the two sections, who is signed in and Sign out. */
export function PlatformHeader({ email, showNav }: { email: string; showNav: boolean }) {
  const pathname = usePathname();
  return (
    <header className="bg-navy-950 text-white">
      <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2 lg:px-8">
        <p className="m-0 flex min-h-11 items-center gap-2 font-display text-[20px] font-extrabold tracking-[-0.01em]">
          Pitline <span className="rounded-full bg-[#1e3a6b] px-2 py-0.5 font-sans text-[12px] font-bold tracking-[0.06em] uppercase">Platform</span>
        </p>
        {showNav ? (
          <nav aria-label="Platform" className="order-3 flex w-full gap-1 sm:order-none sm:w-auto">
            {LINKS.map((link) => {
              const current = link.match(pathname);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "inline-flex min-h-11 items-center rounded-input px-3 text-[14px] font-semibold text-white no-underline hover:bg-navy-900",
                    current && "bg-[#1e3a6b]",
                    focusRingOnDark,
                  )}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
        ) : null}
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden max-w-[240px] truncate text-[13px] text-[#c7d2e2] md:inline">{email}</span>
          <form action={signOutPlatformAction}>
            <button type="submit" className={buttonClass("onDark", "sm")}>
              <LogOut size={16} aria-hidden="true" />
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
