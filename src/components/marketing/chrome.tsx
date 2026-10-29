import Link from "next/link";
import { ArrowRight, Menu, Wrench } from "lucide-react";
import { primaryButton, shell } from "@/components/marketing/styles";
import { marketing } from "@/lib/marketing/content";
import { cn } from "@/lib/utils";

// The marketing site's shared header and footer (styles in ./styles.ts), used by the home
// page (`/`) and the contact page (`/contact`). Server-rendered with no client JavaScript: the mobile
// menu is a native <details>. In-page links (`#plans`) take `base` ("/" off the home page).

type Base = "" | "/";

/** An in-page anchor on the home page, or the home page's anchor from anywhere else. */
function hrefFrom(base: Base, href: string) {
  return href.startsWith("#") ? `${base}${href}` : href;
}

function NavLink({ href, base, current, className, children }: { href: string; base: Base; current?: string; className: string; children: React.ReactNode }) {
  const target = hrefFrom(base, href);
  const ariaCurrent = current === href ? ("page" as const) : undefined;
  return target.startsWith("/") && !target.startsWith("/#") ? (
    <Link href={target} aria-current={ariaCurrent} className={className}>
      {children}
    </Link>
  ) : (
    <a href={target} aria-current={ariaCurrent} className={className}>
      {children}
    </a>
  );
}

export function Logo({ inverse = false }: { inverse?: boolean }) {
  return (
    <Link href="/" aria-label={`${marketing.name} home`} className="inline-flex min-h-11 items-center gap-2.5 rounded-[10px] focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-blue-700">
      <span className="grid size-9 place-items-center rounded-[10px] bg-plate text-navy-950">
        <Wrench size={19} strokeWidth={2.4} aria-hidden="true" />
      </span>
      <span className="flex items-baseline gap-1.5">
        <span className={cn("font-display text-[26px] leading-none font-bold tracking-[0.01em]", inverse ? "text-white" : "text-navy-950")}>{marketing.name}</span>
        <span className={cn("hidden text-[12px] font-medium sm:inline", inverse ? "text-white/75" : "text-grey-600")}>{marketing.by}</span>
      </span>
    </Link>
  );
}

export function SkipLink() {
  return (
    <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-[10px] focus:bg-navy-950 focus:px-4 focus:py-3 focus:text-white">
      Skip to content
    </a>
  );
}

/** `current` is the nav href of the page being shown (e.g. "/contact"), marked aria-current. */
export function MarketingHeader({ base = "", current }: { base?: Base; current?: string }) {
  return (
    <header className="sticky top-0 z-40 border-b border-grey-200 bg-white/90 backdrop-blur-md">
      <div className={cn(shell, "flex h-[68px] items-center justify-between gap-4")}>
        <Logo />
        <nav aria-label="Main" className="hidden items-center gap-1 lg:flex">
          {marketing.nav.map((item) => (
            <NavLink
              key={item.href}
              href={item.href}
              base={base}
              current={current}
              className="inline-flex min-h-11 items-center rounded-[10px] px-3.5 text-[15px] font-medium text-grey-700 transition hover:bg-grey-50 hover:text-navy-950 aria-[current=page]:text-navy-950 aria-[current=page]:underline aria-[current=page]:decoration-plate aria-[current=page]:decoration-[3px] aria-[current=page]:underline-offset-8"
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <Link href={marketing.login.href} className="inline-flex min-h-11 items-center rounded-[10px] px-3.5 text-[15px] font-semibold whitespace-nowrap text-navy-950 transition hover:bg-grey-50">
            {marketing.login.label}
          </Link>
          <Link href={marketing.start.href} className="hidden min-h-11 items-center gap-1.5 rounded-control bg-plate px-4 text-[15px] font-semibold whitespace-nowrap text-plate-ink transition hover:bg-[#ffd21f] sm:inline-flex">
            {marketing.start.label}
          </Link>
          <details className="group relative lg:hidden">
            <summary aria-label="Menu" className="grid size-11 cursor-pointer list-none place-items-center rounded-[10px] border border-grey-200 text-navy-950 [&::-webkit-details-marker]:hidden">
              <Menu size={20} aria-hidden="true" />
            </summary>
            <nav aria-label="Menu" className="absolute top-[calc(100%+10px)] right-0 w-[min(300px,calc(100vw-32px))] rounded-card border border-grey-200 bg-white p-2 shadow-[0_24px_48px_-20px_rgba(7,17,39,0.35)]">
              {marketing.nav.map((item) => (
                <NavLink
                  key={item.href}
                  href={item.href}
                  base={base}
                  current={current}
                  className="flex min-h-11 items-center rounded-[10px] px-3 text-[16px] font-medium text-navy-950 hover:bg-grey-50 aria-[current=page]:bg-grey-50 aria-[current=page]:font-semibold"
                >
                  {item.label}
                </NavLink>
              ))}
              <Link href={marketing.start.href} className="mt-1 flex min-h-11 items-center justify-center rounded-[12px] bg-plate px-3 text-[16px] font-semibold text-plate-ink">
                {marketing.start.label}
              </Link>
            </nav>
          </details>
        </div>
      </div>
    </header>
  );
}

export function MarketingFooter({ base = "" }: { base?: Base }) {
  const { footer } = marketing;
  return (
    <footer className="bg-navy-950 text-white">
      <div className={cn(shell, "py-14")}>
        <div className="flex flex-col gap-6 rounded-hero border border-navy-line bg-navy-900 p-6 md:flex-row md:items-center md:justify-between md:p-8">
          <div>
            <p className="font-display text-[32px] leading-none font-bold">Get your garage booked up.</p>
            <p className="mt-2 text-[15px] text-white/75">Free link today, your own domain when you&apos;re ready.</p>
          </div>
          <Link href={marketing.start.href} className={cn(primaryButton, "shrink-0")}>
            {marketing.start.label} <ArrowRight size={18} aria-hidden="true" />
          </Link>
        </div>
        <div className="mt-12 grid gap-10 md:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div>
            <Logo inverse />
            <p className="mt-3 max-w-[300px] text-[14px] leading-[1.6] text-white/75">{marketing.description}</p>
          </div>
          {footer.columns.map((column) => (
            <nav key={column.title} aria-label={`Footer: ${column.title}`}>
              <h2 className="font-sans text-[13px] font-semibold tracking-[0.1em] text-plate uppercase">{column.title}</h2>
              <ul className="mt-3 space-y-1">
                {column.links.map((link) => (
                  <li key={link.href}>
                    <NavLink href={link.href} base={base} className="inline-flex min-h-11 items-center text-[15px] text-white/80 hover:text-white">
                      {link.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <p className="mt-10 border-t border-navy-line pt-6 text-[13px] text-white/75">
          © {new Date().getFullYear()} {footer.company}. {marketing.name} is a Vitalos product.
        </p>
      </div>
    </footer>
  );
}
