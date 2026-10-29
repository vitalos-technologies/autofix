import type { Metadata } from "next";
import { cookies } from "next/headers";
import { CircleCheck, CircleX, Clock, Info, Phone, Wrench } from "lucide-react";
import { formatSlotLabel, PlateChip } from "@/components/book";
import { MediaGallery } from "@/components/health-checks/media-gallery";
import { RatingChip, RatingSummary, RATING_TONES } from "@/components/health-checks/rating";
import { formatPounds, groupBySection, ratingCounts, recommendedItems, visibleItems, type ChecklistItem } from "@/lib/health-checks/checklist";
import { HEALTH_CHECK_LINK_PROBLEMS, type HealthCheckLinkProblem } from "@/lib/health-checks/link-route";
import { HealthCheckDataError, loadCustomerHealthCheck, type HealthCheckDetail } from "@/lib/health-checks/server";
import { HEALTH_CHECK_COOKIE, readHealthCheckSession } from "@/lib/health-checks/token";
import { mediaByItem, type HealthCheckMedia } from "@/lib/health-checks/view";
import { garageHasFeature } from "@/lib/plans/server";
import { createAdminClient } from "@/lib/supabase/server";
import { formatPhoneForDisplay, telHref } from "@/lib/tenancy/contact";
import { requireSiteGarage, type Garage } from "@/lib/tenancy/garage";
import { cn } from "@/lib/utils";
import { BookingScreen } from "../_components/booking-screen";
import { HealthCheckDecisions } from "../_components/health-check-decisions";
import { ManageNotice, managePrimaryAction } from "../_components/manage-ui";

export const metadata: Metadata = {
  title: "Your car's health check",
  robots: { index: false, follow: false, nocache: true },
};

const SUBTITLE = "Vehicle health check";
const iconProps = { size: 20, strokeWidth: 2 } as const;

type PageProps = {
  params: Promise<{ garageId: string }>;
  /** `?link=` (the link did not open a check) and `?done=1` (after confirming). Neither is personal data. */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function CallGarage({ garage }: { garage: Garage }) {
  const tel = telHref(garage.phone);
  if (!tel) return null;
  return (
    <a href={tel} className={managePrimaryAction}>
      <Phone size={18} strokeWidth={2} aria-hidden="true" className="shrink-0" />
      Call {formatPhoneForDisplay(garage.phone)}
    </a>
  );
}

const LINK_TEXT: Record<HealthCheckLinkProblem | "session", { title: string; body: string }> = {
  invalid: { title: "That link didn't open a health check", body: "It may have been replaced by a newer message. Open the latest link the garage sent you, or call them." },
  expired: { title: "This link has expired", body: "Health check links work for 14 days. Call the garage and they'll send a new one." },
  limited: { title: "Too many attempts", body: "Please wait a few minutes and open the link again." },
  unavailable: { title: "We couldn't open your health check just now", body: "Please try the link again in a moment." },
  session: { title: "Open the link in your message", body: "For your security, this page closes after an hour. Open the link the garage sent you again to see your car's health check." },
};

function NoCheck({ garage, kind }: { garage: Garage; kind: HealthCheckLinkProblem | "session" }) {
  const text = LINK_TEXT[kind];
  return (
    <BookingScreen garage={garage} subtitle={SUBTITLE} withActionBar={false}>
      <div className="flex flex-col gap-[18px] px-5 pt-[22px] pb-8">
        <h1 className="m-0 font-display text-[36px] leading-[0.98] font-extrabold text-navy-950">Your car&apos;s health check</h1>
        <ManageNotice tone="warning" icon={<Info {...iconProps} />} title={text.title}>
          {text.body}
        </ManageNotice>
        <CallGarage garage={garage} />
      </div>
    </BookingScreen>
  );
}

function CustomerItem({ item, media }: { item: ChecklistItem; media: HealthCheckMedia[] }) {
  return (
    <li className={cn("flex flex-col gap-2 rounded-control border border-grey-200 border-l-4 bg-white px-3.5 py-3", RATING_TONES[item.rating].border)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[15px] font-bold text-navy-950">{item.label}</span>
        <RatingChip rating={item.rating} />
      </div>
      {item.note ? <p className="m-0 text-[14.5px] leading-normal whitespace-pre-wrap text-grey-800">{item.note}</p> : null}
      {item.recommendedWork && item.pricePence !== null ? (
        <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] text-grey-800">
          <Wrench size={16} strokeWidth={2} aria-hidden="true" className="text-grey-600" />
          <span className="font-semibold">Recommended: {item.recommendedWork}</span>
          <span>{formatPounds(item.pricePence)}</span>
          {item.decision === "approved" ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-success-bg px-2.5 py-1 text-[12.5px] font-bold text-success-ink">
              <CircleCheck size={14} strokeWidth={2.2} aria-hidden="true" /> You approved
            </span>
          ) : item.decision === "declined" ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-grey-100 px-2.5 py-1 text-[12.5px] font-bold text-grey-700">
              <CircleX size={14} strokeWidth={2.2} aria-hidden="true" /> You declined
            </span>
          ) : null}
        </p>
      ) : null}
      <MediaGallery media={media} label={item.label} />
    </li>
  );
}

/**
 * The customer's health check on the garage host (P5.3): opened only through the signed `af_hc`
 * session from the `/hc/<token>` link (no id, token or registration in this URL). Each line with its
 * rating, note, photos and video and price; Approve or Decline for each recommended job, the total,
 * and Confirm. After confirming (or for an answered check) it shows what they chose.
 */
export default async function HealthCheckCustomerPage({ params, searchParams }: PageProps) {
  const garage = await requireSiteGarage((await params).garageId);
  const query = await searchParams;
  const linkProblem = HEALTH_CHECK_LINK_PROBLEMS.find((value) => value === single(query.link)) ?? null;
  if (linkProblem) return <NoCheck garage={garage} kind={linkProblem} />;

  const session = readHealthCheckSession((await cookies()).get(HEALTH_CHECK_COOKIE)?.value, garage.id);
  if (!session) return <NoCheck garage={garage} kind="session" />;
  const db = createAdminClient();
  if (!db) return <NoCheck garage={garage} kind="unavailable" />;
  let check: HealthCheckDetail | null;
  try {
    check = await loadCustomerHealthCheck(db, garage.id, session.checkId);
  } catch (error) {
    if (!(error instanceof HealthCheckDataError)) throw error;
    return <NoCheck garage={garage} kind="unavailable" />;
  }
  if (!check || check.status === "draft") return <NoCheck garage={garage} kind="invalid" />;

  const timeZone = garage.timezone;
  const items = visibleItems(check.items, garage.motEnabled);
  const groups = groupBySection(items.filter((item) => item.rating !== "not_checked" || item.recommendedWork));
  const media = mediaByItem(check.media);
  const recommended = recommendedItems(items);
  const expired = check.linkExpiresAt !== null && Date.parse(check.linkExpiresAt) <= new Date().getTime();
  const pro = garageHasFeature(garage, "health_checks");
  const canDecide = check.status === "sent" && pro && !expired;
  const done = single(query.done) === "1" && check.status === "responded";

  return (
    <BookingScreen garage={garage} subtitle={SUBTITLE} withActionBar={false}>
      <div className="flex flex-col gap-[18px] px-5 pt-[22px] pb-8">
        {done ? (
          <ManageNotice live tone="success" icon={<CircleCheck {...iconProps} />} title="Thanks, your answer is with the garage">
            {check.approvedTotalPence > 0
              ? `${garage.name} will go ahead with the work you approved (${formatPounds(check.approvedTotalPence)}).`
              : `${garage.name} won't do any extra work. They'll be in touch when the car is ready.`}
          </ManageNotice>
        ) : null}
        <h1 className="m-0 font-display text-[36px] leading-[0.98] font-extrabold text-navy-950">Your car&apos;s health check</h1>

        <section aria-label="Your car" className="flex flex-col gap-3 rounded-hero border border-grey-200 bg-white p-[18px]">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {check.registration ? <PlateChip registration={check.registration} /> : null}
            {check.vehicleName ? <span className="text-[15px] font-bold text-navy-950">{check.vehicleName}</span> : null}
          </div>
          <p className="m-0 text-[13.5px] text-grey-600">
            Checked by {garage.name}
            {check.sentAt ? ` · ${formatSlotLabel(check.sentAt, timeZone)}` : ""}
            {check.mileage !== null ? ` · ${check.mileage.toLocaleString("en-GB")} miles` : ""}
          </p>
          <RatingSummary counts={ratingCounts(items)} />
          {check.summary ? <p className="m-0 border-t border-grey-200 pt-3 text-[15px] leading-normal whitespace-pre-wrap text-grey-800">{check.summary}</p> : null}
          <MediaGallery media={media.get("check") ?? []} label="your car" />
        </section>

        {groups.map((group) => (
          <section key={group.section} aria-labelledby={`hc-${group.section}`} className="flex flex-col gap-2.5">
            <h2 id={`hc-${group.section}`} className="m-0 text-[13px] font-bold tracking-[0.06em] text-grey-600 uppercase">
              {group.label}
            </h2>
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              {group.items.map((item) => (
                <CustomerItem key={item.id} item={item} media={media.get(item.id) ?? []} />
              ))}
            </ul>
          </section>
        ))}

        {canDecide ? (
          <section aria-labelledby="hc-decide" className="flex flex-col gap-3">
            <h2 id="hc-decide" className="m-0 font-display text-[28px] leading-none font-extrabold text-navy-950">
              {recommended.length > 0 ? "Approve the work you want" : "Anything else?"}
            </h2>
            <p className="m-0 text-[14px] leading-normal text-grey-700">
              {recommended.length > 0
                ? `Approve or decline each job. ${garage.name} only does the work you approve, at these prices.`
                : `${garage.name} didn't find anything that needs work. Let them know you've seen this.`}
            </p>
            <HealthCheckDecisions items={recommended} />
          </section>
        ) : check.status === "responded" ? (
          <section aria-label="Your answer" className="flex items-center justify-between gap-3 rounded-hero bg-navy-950 px-4 py-3.5 text-white">
            <span className="text-[14px] font-semibold">You approved</span>
            <span className="font-display text-[26px] leading-none font-bold">{formatPounds(check.approvedTotalPence)}</span>
          </section>
        ) : (
          <ManageNotice tone="info" icon={<Clock {...iconProps} />} title="Approve by phone">
            {expired ? "This link has expired. " : ""}Call {garage.name} to approve or decline the recommended work.
          </ManageNotice>
        )}
        {canDecide ? null : <CallGarage garage={garage} />}
        <p className="m-0 text-center text-[11px] text-grey-600">Powered by Pitline</p>
      </div>
    </BookingScreen>
  );
}
