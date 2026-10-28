import Link from "next/link";
import {
  ArrowRight,
  BellRing,
  Check,
  ChevronDown,
  Globe,
  LockKeyhole,
  Menu,
  PhoneCall,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { BookingScreen, FeatureArt, FloatingCard, PhoneFrame, TodayScreen } from "@/components/marketing/illustrations";
import { marketing } from "@/lib/marketing/content";
import { cn } from "@/lib/utils";

// The Autofix marketing page on the admin host (`/`). Same section order as the Answerd site (header,
// hero, trust strip, how it works, features, phone band, for-the-business, FAQs, footer) in Autofix's
// navy and number-plate yellow. Server-rendered with no client JavaScript: the mobile menu and the FAQs
// are native <details>.

const shell = "mx-auto w-full max-w-[1180px] px-4 md:px-6";
const primaryButton =
  "inline-flex min-h-[54px] items-center justify-center gap-2 rounded-control bg-plate px-6 text-[16px] font-semibold text-plate-ink shadow-[0_14px_30px_-14px_rgba(246,199,0,0.9)] transition hover:-translate-y-0.5 hover:bg-[#ffd21f] focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-blue-700 [&_svg]:transition-transform hover:[&_svg]:translate-x-0.5";
const outlineButton =
  "inline-flex min-h-[54px] items-center justify-center gap-2 rounded-control border border-grey-300 bg-white px-6 text-[16px] font-semibold text-navy-950 transition hover:-translate-y-0.5 hover:border-blue-700 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-blue-700";

const trustIcons = { globe: Globe, shield: ShieldCheck, bell: BellRing, phone: PhoneCall } as const;

function Logo({ inverse = false }: { inverse?: boolean }) {
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

function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-grey-200 bg-white/90 backdrop-blur-md">
      <div className={cn(shell, "flex h-[68px] items-center justify-between gap-4")}>
        <Logo />
        <nav aria-label="Main" className="hidden items-center gap-1 lg:flex">
          {marketing.nav.map((item) => (
            <a key={item.href} href={item.href} className="inline-flex min-h-11 items-center rounded-[10px] px-3.5 text-[15px] font-medium text-grey-700 transition hover:bg-grey-50 hover:text-navy-950">
              {item.label}
            </a>
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
                <a key={item.href} href={item.href} className="flex min-h-11 items-center rounded-[10px] px-3 text-[16px] font-medium text-navy-950 hover:bg-grey-50">
                  {item.label}
                </a>
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

function Hero() {
  const { hero } = marketing;
  return (
    <section aria-labelledby="hero-heading" className="relative overflow-hidden bg-[radial-gradient(60%_55%_at_85%_20%,rgba(246,199,0,0.18),transparent_70%)]">
      <div className={cn(shell, "grid items-center gap-12 pt-12 pb-16 md:pt-16 md:pb-28 lg:grid-cols-[1.05fr_0.95fr] lg:gap-8 lg:pt-20")}>
        <div className="mk-fade-up">
          <p className="inline-flex items-center gap-2 rounded-full border border-grey-200 bg-white px-3.5 py-1.5 text-[13px] font-semibold text-navy-950 shadow-[0_6px_16px_-12px_rgba(7,17,39,0.4)]">
            <span className="relative flex size-2" aria-hidden="true">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-success" />
            </span>
            {hero.badge}
          </p>
          <h1 id="hero-heading" className="mt-5 font-display text-[54px] leading-[0.95] font-bold tracking-[-0.01em] text-navy-950 sm:text-[68px] lg:text-[80px]">
            {hero.headline}{" "}
            <span className="relative inline-block whitespace-nowrap">
              <span aria-hidden="true" className="absolute inset-x-[-4px] bottom-[0.08em] h-[0.32em] -skew-x-6 rounded-[4px] bg-plate" />
              <span className="relative">{hero.highlight}</span>
            </span>
          </h1>
          <p className="mt-5 max-w-[540px] text-[18px] leading-[1.6] text-grey-700">{hero.subline}</p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link href={marketing.start.href} className={primaryButton}>
              {marketing.start.label} <ArrowRight size={18} aria-hidden="true" />
            </Link>
            <a href={hero.secondary.href} className={outlineButton}>
              {hero.secondary.label}
            </a>
          </div>
          <ul className="mt-7 flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:gap-x-6">
            {hero.notes.map((note) => (
              <li key={note} className="flex items-center gap-2 text-[14px] font-medium text-grey-700">
                <span className="grid size-5 place-items-center rounded-full bg-success-bg text-success-ink" aria-hidden="true">
                  <Check size={12} strokeWidth={3} />
                </span>
                {note}
              </li>
            ))}
          </ul>
        </div>
        <div className="relative flex justify-center lg:justify-end lg:pr-10">
          <div className="mk-fade-up relative [animation-delay:120ms]">
            <PhoneFrame label="A garage's booking page on a phone: the customer has entered their registration, the car has been found and MOT is selected.">
              <BookingScreen />
            </PhoneFrame>
            {/* Both cards sit on the frame's edge, clear of the screen's text; the left one only where the text column leaves room. */}
            <div className="absolute top-[40%] -left-[205px] hidden md:block lg:hidden xl:block">
              <FloatingCard kind="booked" />
            </div>
            <div className="absolute -right-[48px] -bottom-[56px] hidden md:block">
              <FloatingCard kind="reminder" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function TrustStrip() {
  return (
    <section aria-labelledby="trust-heading" className={cn(shell, "-mt-4 pb-6 md:pb-10")}>
      <div className="rounded-hero border border-grey-200 bg-white p-5 shadow-[0_20px_44px_-30px_rgba(7,17,39,0.35)] md:p-7">
        <h2 id="trust-heading" className="font-sans text-[12px] font-semibold tracking-[0.12em] text-grey-600 uppercase">
          {marketing.trustLabel}
        </h2>
        <ul className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {marketing.trust.map((item) => {
            const Icon = trustIcons[item.icon];
            return (
              <li key={item.label} className="flex items-start gap-3">
                <span className="grid size-11 shrink-0 place-items-center rounded-[12px] bg-navy-950 text-plate" aria-hidden="true">
                  <Icon size={20} />
                </span>
                <span>
                  <span className="block text-[15px] leading-5 font-semibold text-navy-950">{item.label}</span>
                  <span className="mt-0.5 block text-[14px] leading-5 text-grey-600">{item.detail}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

function SectionHeading({ id, eyebrow, heading, intro, inverse = false }: { id: string; eyebrow?: string; heading: string; intro?: string; inverse?: boolean }) {
  return (
    <div className="max-w-[640px]">
      {eyebrow ? <p className={cn("text-[13px] font-semibold tracking-[0.12em] uppercase", inverse ? "text-plate" : "text-blue-700")}>{eyebrow}</p> : null}
      <h2 id={id} className={cn("mt-2 font-display text-[40px] leading-[1] font-bold md:text-[52px]", inverse ? "text-white" : "text-navy-950")}>
        {heading}
      </h2>
      {intro ? <p className={cn("mt-4 text-[17px] leading-[1.6]", inverse ? "text-white/80" : "text-grey-700")}>{intro}</p> : null}
    </div>
  );
}

function HowItWorks() {
  const { howItWorks } = marketing;
  return (
    <section id={howItWorks.id} aria-labelledby="how-heading" className="scroll-mt-20 py-16 md:py-24">
      <div className={shell}>
        <SectionHeading id="how-heading" eyebrow="Three steps" heading={howItWorks.heading} intro={howItWorks.intro} />
        <ol className="relative mt-12 grid gap-5 md:grid-cols-3 md:gap-6">
          <span aria-hidden="true" className="absolute top-[52px] right-[16%] left-[16%] hidden border-t-2 border-dashed border-grey-300 md:block" />
          {howItWorks.steps.map((step, index) => (
            <li key={step.title} className="relative rounded-card border border-grey-200 bg-white p-6 shadow-[0_16px_36px_-30px_rgba(7,17,39,0.45)]">
              <span aria-hidden="true" className="grid size-14 place-items-center rounded-[14px] bg-plate font-display text-[30px] leading-none font-bold text-plate-ink shadow-[0_0_0_6px_#fff]">
                {index + 1}
              </span>
              <h3 className="mt-5 text-[24px] leading-tight font-bold text-navy-950">
                <span className="sr-only">Step {index + 1}: </span>
                {step.title}
              </h3>
              <p className="mt-2 text-[15px] leading-[1.6] text-grey-600">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Features() {
  const { features } = marketing;
  return (
    <section id={features.id} aria-labelledby="features-heading" className="scroll-mt-20 bg-grey-50 py-16 md:py-24">
      <div className={shell}>
        <SectionHeading id="features-heading" eyebrow="Features" heading={features.heading} />
        <ul className="mt-12 grid gap-5 md:grid-cols-2 md:gap-6">
          {features.items.map((item) => (
            <li key={item.key} className="flex flex-col overflow-hidden rounded-hero border border-grey-200 bg-white">
              <div aria-hidden="true" className="flex min-h-[230px] items-center justify-center bg-[linear-gradient(rgba(20,70,165,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(20,70,165,0.06)_1px,transparent_1px)] bg-[size:28px_28px] px-4 py-8">
                <FeatureArt kind={item.key} />
              </div>
              <div className="border-t border-grey-200 p-6">
                <h3 className="text-[26px] leading-tight font-bold text-navy-950">{item.title}</h3>
                <p className="mt-2 text-[15px] leading-[1.6] text-grey-600">{item.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function PhoneBand() {
  const { band } = marketing;
  return (
    <section id={band.id} aria-labelledby="band-heading" className="hero-grid relative overflow-hidden text-white">
      <div className={cn(shell, "grid items-center gap-12 py-16 md:py-20 lg:grid-cols-[1fr_auto] lg:gap-16")}>
        <div>
          <SectionHeading id="band-heading" eyebrow="The admin" heading={band.headline} intro={band.line} inverse />
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link href={marketing.start.href} className={primaryButton}>
              {marketing.start.label} <ArrowRight size={18} aria-hidden="true" />
            </Link>
            <Link href={marketing.login.href} className="inline-flex min-h-[54px] items-center justify-center rounded-control border border-white/35 px-6 text-[16px] font-semibold text-white transition hover:border-white hover:bg-white/10">
              {marketing.login.label}
            </Link>
          </div>
        </div>
        <div className="flex justify-center lg:pr-6">
          <PhoneFrame label="The admin's Today screen on a phone: today's bookings, a request waiting to be accepted and a missed call that was texted back." className="ring-1 ring-white/15 lg:rotate-[-5deg]">
            <TodayScreen />
          </PhoneFrame>
        </div>
      </div>
    </section>
  );
}

function ForGarages() {
  const { garages } = marketing;
  return (
    <section id={garages.id} aria-labelledby="garages-heading" className="scroll-mt-20 py-16 md:py-24">
      <div className={cn(shell, "grid items-center gap-12 lg:grid-cols-2 lg:gap-16")}>
        <div>
          <SectionHeading id="garages-heading" eyebrow="For garages" heading={garages.headline} />
          <ul className="mt-8 space-y-4">
            {garages.points.map((point) => (
              <li key={point} className="flex items-start gap-3 text-[16px] leading-[1.5] text-grey-800">
                <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-success-bg text-success-ink" aria-hidden="true">
                  <Check size={14} strokeWidth={3} />
                </span>
                {point}
              </li>
            ))}
          </ul>
          <p className="mt-8 rounded-card border-l-4 border-plate bg-grey-50 px-5 py-4 text-[15px] leading-[1.6] text-grey-700">{garages.note}</p>
        </div>
        <div aria-hidden="true" className="relative mx-auto w-full max-w-[420px] pb-4">
          <div className="rounded-hero border border-grey-200 bg-white p-5 shadow-[0_24px_48px_-30px_rgba(7,17,39,0.45)]">
            <p className="text-[12px] font-semibold tracking-[0.1em] text-grey-600 uppercase">Booking domain</p>
            <p className="mt-2 flex items-center gap-2 font-mono text-[15px] font-semibold break-all text-navy-950">
              <LockKeyhole size={16} className="shrink-0 text-success-ink" /> book.kingswayautocare.co.uk
            </p>
            <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-success-bg px-2.5 py-1 text-[12px] font-semibold text-success-ink">
              <Check size={13} strokeWidth={3} /> Connected · certificate active
            </p>
          </div>
          <div className="relative z-10 -mt-3 ml-6 rounded-hero border border-grey-200 bg-white p-5 shadow-[0_24px_48px_-30px_rgba(7,17,39,0.45)] sm:ml-10">
            <div className="flex items-center justify-between gap-4">
              <span>
                <span className="block text-[15px] font-semibold text-navy-950">MOT testing</span>
                <span className="block text-[13px] text-grey-600">Show MOT services and due dates</span>
              </span>
              <span className="flex h-7 w-12 shrink-0 items-center justify-end rounded-full bg-blue-700 p-1">
                <span className="size-5 rounded-full bg-white" />
              </span>
            </div>
          </div>
          <div className="relative z-20 -mt-3 mr-4 rounded-hero bg-navy-950 p-5 text-white shadow-[0_24px_48px_-24px_rgba(7,17,39,0.6)] sm:mr-8">
            <p className="text-[12px] font-semibold tracking-[0.1em] text-white/75 uppercase">Reminders</p>
            <p className="mt-1 font-display text-[34px] leading-none font-bold">
              214 <span className="text-[18px] font-semibold text-white/80">customers opted in</span>
            </p>
            <p className="mt-2 text-[13px] text-white/75">Sent 09:00 to 19:00, Monday to Saturday</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function Plans() {
  const { plans } = marketing;
  return (
    <section id={plans.id} aria-labelledby="plans-heading" className="scroll-mt-20 bg-grey-50 py-16 md:py-24">
      <div className={shell}>
        <SectionHeading id="plans-heading" eyebrow="Plans" heading={plans.heading} intro={plans.intro} />
        <div className="mt-12 grid gap-5 lg:grid-cols-2 lg:gap-6">
          <article aria-labelledby="plan-essentials" className="flex flex-col rounded-hero border border-grey-200 bg-white p-6 shadow-[0_16px_36px_-30px_rgba(7,17,39,0.45)] md:p-8">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 id="plan-essentials" className="text-[38px] leading-none font-bold text-navy-950">{plans.essentials.name}</h3>
                <p className="mt-1.5 text-[16px] text-grey-700">{plans.essentials.tagline}</p>
              </div>
              <p className="rounded-full bg-success-bg px-3 py-1 text-[13px] font-semibold text-success-ink">{plans.essentials.status}</p>
            </div>
            <ul className="mt-6 flex-1 space-y-3">
              {plans.essentials.features.map((feature) => (
                <li key={feature} className="flex items-start gap-3 text-[15px] leading-[1.5] text-grey-800">
                  <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-success-bg text-success-ink" aria-hidden="true">
                    <Check size={12} strokeWidth={3} />
                  </span>
                  {feature}
                </li>
              ))}
            </ul>
            <Link href={plans.cta.href} className={cn(primaryButton, "mt-8 w-full sm:w-fit")}>
              {plans.cta.label} <ArrowRight size={18} aria-hidden="true" />
            </Link>
          </article>
          <article aria-labelledby="plan-pro" className="flex flex-col rounded-hero bg-navy-950 p-6 text-white shadow-[0_24px_48px_-24px_rgba(7,17,39,0.6)] md:p-8">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 id="plan-pro" className="text-[38px] leading-none font-bold">{plans.pro.name}</h3>
                <p className="mt-1.5 text-[16px] text-white/80">{plans.pro.tagline}</p>
              </div>
              <p className="rounded-full bg-plate px-3 py-1 text-[13px] font-semibold text-plate-ink">{plans.pro.status}</p>
            </div>
            <p className="mt-6 text-[15px] font-semibold text-plate">{plans.pro.lead}</p>
            <ul className="mt-3 flex-1 space-y-3">
              {plans.pro.features.map((feature) => (
                <li key={feature} className="flex items-start gap-3 text-[15px] leading-[1.5] text-white/90">
                  <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-plate text-plate-ink" aria-hidden="true">
                    <Check size={12} strokeWidth={3} />
                  </span>
                  {feature}
                </li>
              ))}
            </ul>
            <p className="mt-8 border-t border-navy-line pt-5 text-[14px] leading-[1.6] text-white/75">{plans.pro.note}</p>
          </article>
        </div>
      </div>
    </section>
  );
}

function Faqs() {
  const { faqs } = marketing;
  return (
    <section id={faqs.id} aria-labelledby="faqs-heading" className="scroll-mt-20 py-16 md:py-24">
      <div className={cn(shell, "grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16")}>
        <div>
          <SectionHeading id="faqs-heading" eyebrow="FAQs" heading={faqs.heading} />
          <p className="mt-4 text-[16px] leading-[1.6] text-grey-700">
            Ready to try it?{" "}
            <Link href={marketing.start.href} className="font-semibold text-blue-700 underline underline-offset-4 hover:text-navy-950">
              Set up your garage
            </Link>{" "}
            and see your booking page in minutes.
          </p>
        </div>
        <div className="divide-y divide-grey-200 rounded-hero border border-grey-200 bg-white">
          {faqs.items.map((item) => (
            <details key={item.q} className="group px-5 md:px-6">
              <summary className="flex min-h-[60px] cursor-pointer list-none items-center justify-between gap-4 py-4 text-[17px] font-semibold text-navy-950 [&::-webkit-details-marker]:hidden">
                {item.q}
                <ChevronDown size={20} aria-hidden="true" className="shrink-0 text-grey-600 transition-transform group-open:rotate-180" />
              </summary>
              <p className="pb-5 text-[15px] leading-[1.65] text-grey-700">{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function Footer() {
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
                    {link.href.startsWith("/") ? (
                      <Link href={link.href} className="inline-flex min-h-11 items-center text-[15px] text-white/80 hover:text-white">
                        {link.label}
                      </Link>
                    ) : (
                      <a href={link.href} className="inline-flex min-h-11 items-center text-[15px] text-white/80 hover:text-white">
                        {link.label}
                      </a>
                    )}
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

export function MarketingPage() {
  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-[10px] focus:bg-navy-950 focus:px-4 focus:py-3 focus:text-white">
        Skip to content
      </a>
      <Header />
      <main id="main">
        <Hero />
        <TrustStrip />
        <HowItWorks />
        <Features />
        <PhoneBand />
        <ForGarages />
        <Plans />
        <Faqs />
      </main>
      <Footer />
    </>
  );
}
