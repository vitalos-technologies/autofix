import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, MessageSquareText } from "lucide-react";
import { MarketingFooter, MarketingHeader, SkipLink } from "@/components/marketing/chrome";
import { shell } from "@/components/marketing/styles";
import { marketing } from "@/lib/marketing/content";
import { cn } from "@/lib/utils";
import { ContactForm } from "./contact-form";

// `/contact` on the admin host (the marketing site). Garage hosts never reach it: the proxy rewrites
// them to /_site. Indexable like `/` (robots.ts allows both); the form posts to /api/contact.
export const metadata: Metadata = {
  title: { absolute: marketing.contact.metaTitle },
  description: marketing.contact.description,
  robots: { index: true, follow: true },
  openGraph: { type: "website", siteName: marketing.name, title: marketing.contact.metaTitle, description: marketing.contact.description },
};

export default function ContactPage() {
  const { contact } = marketing;
  return (
    <>
      <SkipLink />
      <MarketingHeader base="/" current="/contact" />
      <main id="main" className="bg-[radial-gradient(60%_45%_at_90%_0%,rgba(246,199,0,0.16),transparent_70%)]">
        <div className={cn(shell, "pt-10 pb-16 md:pt-14 md:pb-24")}>
          <div className="max-w-[760px]">
            <p className="text-[13px] font-semibold tracking-[0.12em] text-blue-700 uppercase">{contact.eyebrow}</p>
            <h1 className="mt-2 font-display text-[46px] leading-[0.98] font-bold tracking-[-0.01em] text-navy-950 sm:text-[58px] lg:text-[66px]">{contact.heading}</h1>
            <p className="mt-4 max-w-[600px] text-[17px] leading-[1.6] text-grey-700">{contact.intro}</p>
          </div>
          <div className="mt-8 grid items-start gap-10 lg:grid-cols-[1.25fr_0.75fr] lg:gap-12">
            <div className="min-w-0">
              <ContactForm copy={{ form: contact.form, thanks: contact.thanks }} />
            </div>
            <aside aria-labelledby="contact-next-heading" className="flex flex-col gap-5">
              <section className="rounded-hero bg-navy-950 p-6 text-white shadow-[0_24px_48px_-24px_rgba(7,17,39,0.6)] md:p-7">
                <span className="grid size-11 place-items-center rounded-[12px] bg-plate text-navy-950" aria-hidden="true">
                  <MessageSquareText size={21} />
                </span>
                <h2 id="contact-next-heading" className="mt-4 text-[22px] leading-tight font-bold">{contact.aside.heading}</h2>
                <ol className="mt-4 space-y-3">
                  {contact.aside.steps.map((step, index) => (
                    <li key={step} className="flex items-start gap-3 text-[15px] leading-[1.5] text-white/90">
                      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-plate font-display text-[15px] leading-none font-bold text-plate-ink" aria-hidden="true">
                        {index + 1}
                      </span>
                      {step}
                    </li>
                  ))}
                </ol>
                <p className="mt-5 border-t border-navy-line pt-4 text-[14px] leading-[1.6] text-white/75">{contact.aside.privacy}</p>
              </section>
              <ul className="grid gap-3">
                {[contact.aside.customers, contact.aside.start].map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="group flex min-h-[60px] items-center justify-between gap-3 rounded-card border border-grey-200 bg-white px-5 py-3 transition hover:border-blue-700 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
                    >
                      <span>
                        <span className="block text-[13px] text-grey-600">{link.lead}</span>
                        <span className="block text-[16px] font-semibold text-navy-950">{link.label}</span>
                      </span>
                      <ArrowRight size={18} aria-hidden="true" className="shrink-0 text-blue-700 transition-transform group-hover:translate-x-0.5" />
                    </Link>
                  </li>
                ))}
              </ul>
            </aside>
          </div>
        </div>
      </main>
      <MarketingFooter base="/" />
    </>
  );
}
