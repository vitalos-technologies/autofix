import { Lock, Sparkles } from "lucide-react";
import Link from "next/link";
import { Badge, buttonClass, PageHeader, Panel } from "@/components/admin-ui";
import { FEATURES, type Feature } from "@/lib/plans/features";

/** "Pro" chip with a lock, next to a feature the garage's plan doesn't include. */
export function ProBadge({ className }: { className?: string }) {
  return (
    <Badge tone="navy" size="xs" className={className}>
      <span className="inline-flex items-center gap-1">
        <Lock size={11} strokeWidth={2.4} aria-hidden="true" />
        Pro
      </span>
    </Badge>
  );
}

export type ProLockedCardProps = {
  feature: Feature;
  /** Owners can upgrade; everyone else is told to ask the owner. */
  canUpgrade: boolean;
  /** True when the garage once had Pro (trial ended, downgraded): its Pro data stays, read-only. */
  hasExistingData?: boolean;
  headingLevel?: 2 | 3;
};

/**
 * The upgrade card shown wherever an Essentials garage meets a Pro feature (P5.2). The page and its nav
 * link stay; the server refuses the work (403 PLAN_REQUIRED), and this card says why and where to go.
 */
export function ProLockedCard({ feature, canUpgrade, hasExistingData = false, headingLevel = 2 }: ProLockedCardProps) {
  const definition = FEATURES[feature];
  return (
    <Panel
      headingLevel={headingLevel}
      title={
        <span className="inline-flex items-center gap-2">
          {definition.label} is on Pro
          <ProBadge />
        </span>
      }
      highlight
    >
      <div className="flex flex-col gap-4">
        <p className="m-0 text-[15px] leading-[1.5] text-grey-700">{definition.description}</p>
        {hasExistingData ? (
          <p className="m-0 text-[14px] leading-[1.5] text-grey-700">
            Everything you added on Pro is kept. You can still see it here; changing it needs Pro again.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          {canUpgrade ? (
            <Link href="/app/settings/plan#compare" className={buttonClass("primary", "md")}>
              <Sparkles size={16} strokeWidth={2.2} aria-hidden="true" />
              See Pro and upgrade
            </Link>
          ) : (
            <p className="m-0 text-[14px] text-grey-700">Ask the garage owner to upgrade to Pro in Settings, Plan.</p>
          )}
          <Link href="/app/settings/plan#compare" className={buttonClass("ghost", "md")}>
            Compare plans
          </Link>
        </div>
      </div>
    </Panel>
  );
}

/** A whole page for a Pro section the garage can't use: the page title plus the locked card. */
export function ProLockedPage({ feature, title, canUpgrade, hasExistingData }: { feature: Feature; title: string; canUpgrade: boolean; hasExistingData?: boolean }) {
  return (
    <div className="flex flex-col gap-5 pb-10">
      <PageHeader eyebrow="Pro" title={title} description={FEATURES[feature].description} />
      <ProLockedCard feature={feature} canUpgrade={canUpgrade} hasExistingData={hasExistingData} />
    </div>
  );
}
