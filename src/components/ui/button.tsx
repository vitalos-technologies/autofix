import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

const styles = {
  primary: "bg-[#2563EB] text-white shadow-[0_12px_32px_rgba(37,99,235,.28)] hover:bg-[#1D4ED8]",
  secondary: "border border-[#67B9FF]/45 bg-transparent text-white hover:border-[#2563EB] hover:bg-[#2563EB]/10",
  outline: "border border-[#2563EB]/25 bg-white text-[#0f2747] hover:border-[#2563EB]/60 hover:bg-[#F8FAFC]",
  ghost: "bg-transparent text-current hover:bg-[#2563EB]/10",
};

type Shared = { children: ReactNode; variant?: keyof typeof styles; className?: string };

export function Button({ children, variant = "primary", className, ...props }: Shared & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={cn("inline-flex min-h-12 items-center justify-center gap-2 rounded-lg px-5 py-3 text-sm font-bold transition duration-200 hover:-translate-y-0.5 [&_svg]:transition-transform [&_svg]:duration-200 hover:[&_svg]:translate-x-0.5", styles[variant], className)} {...props}>{children}</button>;
}

export function ButtonLink({ children, variant = "primary", className, href, ...props }: Shared & AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return <Link className={cn("inline-flex min-h-12 items-center justify-center gap-2 rounded-lg px-5 py-3 text-sm font-bold transition duration-200 hover:-translate-y-0.5 [&_svg]:transition-transform [&_svg]:duration-200 hover:[&_svg]:translate-x-0.5", styles[variant], href === "/book" && "shadow-none", className)} href={href} {...props}>{children}</Link>;
}
