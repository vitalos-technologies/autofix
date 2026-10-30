import type { Metadata } from "next";
import Link from "next/link";
import { CalendarClock, Clock, Globe, ListChecks } from "lucide-react";
import { CopyButton } from "@/components/admin-ui/copy-button";
import { buttonClass, textLinkClass } from "@/components/admin-ui/styles";
import { OnboardingFrame } from "@/components/onboarding/onboarding-frame";
import { ONBOARDING_PATHS } from "@/components/onboarding/steps";
import { onboardingBookingUrl } from "@/lib/signup/server";
import { redirect } from "next/navigation";
import { requireOnboardingOwner } from "../context";

export const metadata: Metadata = { title: "You're live" };

const NEXT_STEPS = [
  { href: "/app/settings/hours", icon: Clock, title: "Check your opening hours", text: "Add closures and split days." },
  { href: "/app/settings/services", icon: ListChecks, title: "Set your prices and times", text: "Edit services, or add your own." },
  { href: "/app/settings", icon: Globe, title: "Connect your own domain", text: "Later, in Settings: use book.yourgarage.co.uk instead of the free link." },
] as const;

/** Done: the booking link, a test booking and what to do next. */
export default async function OnboardingDonePage() {
  const admin = await requireOnboardingOwner(ONBOARDING_PATHS.done);
  if (admin.garage.status !== "active") redirect(ONBOARDING_PATHS.team);
  const link = onboardingBookingUrl(admin.garage);
  return (
    <OnboardingFrame eyebrow="All set" title="You're live" description={`${admin.garage.name} can take bookings now. Share your booking link with customers.`}>
      <section aria-labelledby="link-heading" className="flex flex-col gap-3 rounded-card bg-navy-950 p-5 text-white">
        <h2 id="link-heading" className="m-0 text-[13px] font-semibold tracking-[0.08em] text-[#cbd5e1] uppercase">Your booking link</h2>
        <p className="m-0 font-mono text-[16px] break-all" data-testid="booking-link">{link}</p>
        <div className="flex flex-wrap gap-2">
          <a href={`${link}/`} target="_blank" rel="noopener" className={buttonClass("onDarkPrimary", "md")}>
            <CalendarClock size={18} aria-hidden="true" /> Book a test
          </a>
          <CopyButton value={link} label="Copy link" srSuffix="booking link" variant="onDark" icon />
        </div>
      </section>
      <section aria-labelledby="next-heading" className="flex flex-col gap-2 rounded-card border border-grey-200 bg-white p-5">
        <h2 id="next-heading" className="m-0 text-[17px] font-bold text-navy-950">Next steps</h2>
        <ul className="m-0 flex list-none flex-col divide-y divide-grey-200 p-0">
          {NEXT_STEPS.map((step) => (
            <li key={step.href} className="flex items-start gap-3 py-3">
              <step.icon size={20} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-text" />
              <span className="flex flex-col">
                <Link href={step.href} className={textLinkClass}>{step.title}</Link>
                <span className="text-[14px] text-grey-600">{step.text}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>
      <Link href="/app" className={buttonClass("primary", "md", "min-h-[54px] w-full text-[16px]")}>Go to your dashboard</Link>
    </OnboardingFrame>
  );
}
