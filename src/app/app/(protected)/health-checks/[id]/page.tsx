import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, CircleCheck, CircleX, FileText, Trash2 } from "lucide-react";
import { z } from "zod";
import { PageHeader, Panel, buttonClass, textLinkClass } from "@/components/admin-ui";
import { formatSlotLabel } from "@/components/book/format";
import { PlateChip } from "@/components/book/plate-chip";
import { MediaGallery } from "@/components/health-checks/media-gallery";
import { RatingChip, RatingSummary, RATING_TONES } from "@/components/health-checks/rating";
import { Notice } from "@/components/onboarding/field";
import { ProLockedCard } from "@/components/plans";
import { approvedTotalPence, formatPounds, groupBySection, ratingCounts, recommendedItems, visibleItems, type ChecklistItem } from "@/lib/health-checks/checklist";
import { canSendHealthCheck } from "@/lib/health-checks/send";
import { HealthCheckDataError, loadHealthCheck, type HealthCheckDetail } from "@/lib/health-checks/server";
import { mediaByItem, type HealthCheckMedia } from "@/lib/health-checks/view";
import { planRequiredMessage } from "@/lib/plans/entitlements";
import { garageHasFeature } from "@/lib/plans/server";
import { getAdminContext } from "@/lib/tenancy/admin";
import { cn } from "@/lib/utils";
import { addToInvoiceAction, deleteItemAction, deleteMediaAction } from "../actions";
import { AddItemForm, LiveRefresh, SendForm, SummaryForm } from "../_components/check-forms";
import { ItemEditor } from "../_components/item-editor";
import { MediaUploader } from "../_components/media-uploader";
import { HealthCheckStatusBadge } from "../_components/status-badge";

export const metadata: Metadata = { title: "Health check" };

const NOTICES: Record<string, { tone: "error" | "success" | "warning"; text: string }> = {
  item_removed: { tone: "success", text: "Line removed." },
  media_removed: { tone: "success", text: "Removed." },
  locked: { tone: "warning", text: "The customer has answered this health check, so it can't be changed." },
  plan: { tone: "warning", text: planRequiredMessage("health_checks") },
  nothing_approved: { tone: "warning", text: "The customer didn't approve any work, so there's nothing to invoice." },
  invoice_denied: { tone: "error", text: "Verify your sign-in to change invoices, then try again." },
  invoice_failed: { tone: "error", text: "The invoice couldn't be updated. Try again, or add the lines on the invoice." },
};

function MediaList({ checkId, media, label, editable }: { checkId: string; media: HealthCheckMedia[]; label: string; editable: boolean }) {
  if (media.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <MediaGallery media={media} label={label} />
      {editable ? (
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          {media.map((entry, index) => (
            <li key={entry.id}>
              <form action={deleteMediaAction}>
                <input type="hidden" name="checkId" value={checkId} />
                <input type="hidden" name="mediaId" value={entry.id} />
                <button type="submit" className={buttonClass("ghost", "sm", "text-[#991b1b]")}>
                  <Trash2 size={16} strokeWidth={2} aria-hidden="true" />
                  Remove {entry.kind === "video" ? "video" : "photo"} {index + 1}
                  <span className="sr-only"> of {label}</span>
                </button>
              </form>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ReadOnlyItem({ item, media }: { item: ChecklistItem; media: HealthCheckMedia[] }) {
  return (
    <li className={cn("flex flex-col gap-2 rounded-[12px] border border-grey-200 border-l-4 bg-white px-3.5 py-3", RATING_TONES[item.rating].border)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[15px] font-bold text-navy-950">{item.label}</span>
        <RatingChip rating={item.rating} short />
      </div>
      {item.note ? <p className="m-0 text-[14px] leading-normal whitespace-pre-wrap text-grey-800">{item.note}</p> : null}
      {item.recommendedWork && item.pricePence !== null ? (
        <p className="m-0 flex flex-wrap items-center gap-2 text-[14px] text-grey-800">
          <span className="font-semibold">{item.recommendedWork}</span>
          <span>{formatPounds(item.pricePence)}</span>
          {item.decision === "approved" ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-success-bg px-2.5 py-1 text-[12.5px] font-bold text-success-ink">
              <CircleCheck size={14} strokeWidth={2.2} aria-hidden="true" /> Approved
            </span>
          ) : item.decision === "declined" ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-grey-100 px-2.5 py-1 text-[12.5px] font-bold text-grey-700">
              <CircleX size={14} strokeWidth={2.2} aria-hidden="true" /> Declined
            </span>
          ) : null}
        </p>
      ) : null}
      <MediaGallery media={media} label={item.label} />
    </li>
  );
}

function CustomerAnswer({ check, canInvoice, timeZone }: { check: HealthCheckDetail; canInvoice: boolean; timeZone: string }) {
  const recommended = recommendedItems(check.items);
  const approved = recommended.filter((item) => item.decision === "approved");
  const declined = recommended.filter((item) => item.decision === "declined");
  return (
    <Panel id="answer" title="Customer's answer" highlight>
      <p className="m-0 font-display text-[34px] leading-none font-bold text-navy-950" data-testid="hc-approved-total">
        {approved.length > 0 ? `Customer approved ${formatPounds(check.approvedTotalPence)}` : "No extra work approved"}
      </p>
      <p className="m-0 text-[14px] text-grey-700">
        {check.respondedAt ? `Answered ${formatSlotLabel(check.respondedAt, timeZone)}. ` : ""}
        {approved.length} approved, {declined.length} declined.
      </p>
      {approved.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {approved.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-3 text-[14px] text-grey-800">
              <span>{item.recommendedWork}</span>
              <span className="font-semibold">{formatPounds(item.pricePence ?? 0)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {approved.length > 0 ? (
        check.invoiceId ? (
          <Link href={`/app/invoices/${check.invoiceId}`} className={buttonClass("secondary", "md", "w-full sm:w-fit")}>
            <FileText size={18} strokeWidth={2} aria-hidden="true" />
            Open the draft invoice
          </Link>
        ) : canInvoice ? (
          <form action={addToInvoiceAction}>
            <input type="hidden" name="checkId" value={check.id} />
            <button type="submit" className={buttonClass("primary", "md", "w-full sm:w-fit")}>
              <FileText size={18} strokeWidth={2} aria-hidden="true" />
              Add approved work to the invoice
            </button>
          </form>
        ) : null
      ) : null}
    </Panel>
  );
}

/**
 * One health check (P5.3): the checklist by section on the phone (rate, note, recommended work and
 * price, photos and video per line), the note to the customer, Send, and the customer's answer as it
 * arrives (refreshed while the link is out). Read-only once the customer answered, and for an
 * Essentials garage (with the Pro card on top).
 */
export default async function HealthCheckPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string }> }) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  const timeZone = admin.garage.timezone || "Europe/London";

  let check: HealthCheckDetail | null;
  try {
    check = await loadHealthCheck(admin.client, id);
  } catch (error) {
    if (!(error instanceof HealthCheckDataError)) throw error;
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="Health check" />
        <Notice tone="error" role="alert">This health check could not be loaded. Refresh the page to try again.</Notice>
      </div>
    );
  }
  if (!check) notFound();

  const notice = NOTICES[(await searchParams).notice ?? ""] ?? null;
  const pro = garageHasFeature(admin.garage, "health_checks");
  const editable = pro && check.status !== "responded" && !admin.impersonation;
  const items = visibleItems(check.items, admin.garage.motEnabled);
  const groups = groupBySection(items);
  const media = mediaByItem(check.media);
  const counts = ratingCounts(items);
  const recommended = recommendedItems(items);
  const quoted = approvedTotalPence(recommended, Object.fromEntries(recommended.map((item) => [item.id, "approved" as const])));
  const mayIncludeCar = [check.vehicleName, check.reference].filter(Boolean).join(" · ");

  return (
    <div className="flex flex-col gap-[18px] pb-10">
      {check.status === "sent" ? <LiveRefresh /> : null}
      <Link href="/app/health-checks" className={cn(textLinkClass, "-mb-2 hidden gap-1.5 self-start text-[14px] lg:inline-flex")}>
        <ArrowLeft size={18} strokeWidth={2} aria-hidden="true" />
        All health checks
      </Link>
      <PageHeader
        eyebrow={check.reference ?? "Health check"}
        title={`Health check: ${check.customerName ?? "customer"}`}
        phoneTitle="Health check"
        description={mayIncludeCar || undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2.5">
            <HealthCheckStatusBadge status={check.status} />
            <Link href={`/app/bookings/${check.bookingId}`} className={buttonClass("secondary", "sm")}>
              Open booking
            </Link>
          </div>
        }
      />
      {!pro ? <ProLockedCard feature="health_checks" canUpgrade={admin.role === "owner"} hasExistingData /> : null}
      {notice ? <Notice tone={notice.tone} role={notice.tone === "success" ? "status" : "alert"}>{notice.text}</Notice> : null}

      <div className="flex flex-wrap items-start gap-[18px]">
        <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-[18px]">
          {check.status === "responded" ? <CustomerAnswer check={check} canInvoice={pro && !admin.impersonation} timeZone={timeZone} /> : null}
          {groups.map((group) => (
            <Panel key={group.section} id={`section-${group.section}`} title={group.label}>
              {editable ? (
                <div className="flex flex-col gap-2.5">
                  {group.items.map((item) => (
                    <div key={item.id} className="flex flex-col gap-1">
                      <ItemEditor
                        checkId={check.id}
                        item={item}
                        media={<MediaList checkId={check.id} media={media.get(item.id) ?? []} label={item.label} editable />}
                        uploader={<MediaUploader checkId={check.id} itemId={item.id} label={item.label} />}
                      />
                      {item.position >= 900 ? (
                        <form action={deleteItemAction} className="self-end">
                          <input type="hidden" name="checkId" value={check.id} />
                          <input type="hidden" name="itemId" value={item.id} />
                          <button type="submit" className={buttonClass("ghost", "sm", "text-[#991b1b]")}>
                            <Trash2 size={16} strokeWidth={2} aria-hidden="true" />
                            Remove line<span className="sr-only">: {item.label}</span>
                          </button>
                        </form>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
                  {group.items.map((item) => (
                    <ReadOnlyItem key={item.id} item={item} media={media.get(item.id) ?? []} />
                  ))}
                </ul>
              )}
            </Panel>
          ))}
          {editable ? (
            <Panel id="add-line" title="Add a line">
              <AddItemForm checkId={check.id} />
            </Panel>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-[18px]">
          <Panel id="summary" title="Summary">
            <div className="flex flex-wrap items-center gap-2.5">
              {check.registration ? <PlateChip registration={check.registration} size="md" /> : null}
              <span className="text-[15px] text-grey-700">{check.vehicleName ?? "Car details not recorded"}</span>
            </div>
            <RatingSummary counts={counts} />
            {recommended.length > 0 ? (
              <p className="m-0 text-[14px] text-grey-700">
                {recommended.length} recommended {recommended.length === 1 ? "job" : "jobs"}, {formatPounds(quoted)} in all.
              </p>
            ) : null}
            {editable ? (
              <>
                <SummaryForm checkId={check.id} summary={check.summary} mileage={check.mileage} />
                <div className="flex flex-col gap-2 border-t border-grey-200 pt-3.5">
                  <h3 className="m-0 text-[14px] font-semibold text-grey-800">Photos and videos of the whole car</h3>
                  <MediaList checkId={check.id} media={media.get("check") ?? []} label="the whole car" editable />
                  <MediaUploader checkId={check.id} itemId={null} label="the whole car" />
                </div>
              </>
            ) : (
              <>
                {check.summary ? <p className="m-0 text-[14px] leading-normal whitespace-pre-wrap text-grey-800">{check.summary}</p> : null}
                {check.mileage !== null ? <p className="m-0 text-[14px] text-grey-700">Mileage: {check.mileage.toLocaleString("en-GB")}</p> : null}
                <MediaGallery media={media.get("check") ?? []} label="the whole car" />
              </>
            )}
          </Panel>

          <Panel id="send" title="Send to the customer">
            {check.status === "responded" ? (
              <p className="m-0 text-[14px] text-grey-700">The customer has answered. Their choices are on this page and on the booking.</p>
            ) : (
              <>
                <p className="m-0 text-[14px] leading-normal text-grey-700">
                  {check.status === "sent"
                    ? `Sent ${check.sentAt ? formatSlotLabel(check.sentAt, timeZone) : ""}${check.sentCount > 1 ? ` (${check.sentCount} times)` : ""}. ${check.firstViewedAt ? "They've opened it." : "Not opened yet."} This page updates when they answer.`
                    : `${check.customerName ?? "The customer"} gets a link by ${check.customerChannel === "email" ? "email" : check.customerChannel === "whatsapp" ? "WhatsApp" : "text"} to see the check and approve or decline each recommended job. The link works for 14 days.`}
                </p>
                {check.customerOptedOut && check.customerChannel !== "email" ? (
                  <Notice tone="warning">This customer has opted out of texts, so the health check can&apos;t be texted. Call them instead.</Notice>
                ) : null}
                {editable && canSendHealthCheck(admin.role) ? (
                  <SendForm checkId={check.id} label={check.status === "sent" ? "Send again with a new link" : "Send to customer"} />
                ) : editable ? (
                  <p className="m-0 text-[14px] text-grey-700">An owner, manager or front desk sends it when you&apos;re done.</p>
                ) : null}
              </>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
