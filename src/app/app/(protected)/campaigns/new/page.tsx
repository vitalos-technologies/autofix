import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader, textLinkClass } from "@/components/admin-ui";
import { ProLockedPage } from "@/components/plans";
import { DEFAULT_TIME_ZONE, localDateKey } from "@/lib/admin/dates";
import { loadCampaignServices, previewAudience } from "@/lib/campaigns/admin";
import type { CampaignSegment } from "@/lib/campaigns/segment";
import { campaignSampleValues, isCampaignStarter, starterSegment, starterService, STARTERS } from "@/lib/campaigns/templates";
import { garageHasFeature } from "@/lib/plans/server";
import { roleAllows, requireSetupContext } from "@/lib/settings/server";
import { garageBaseUrl } from "@/lib/tenancy/urls";
import { cn } from "@/lib/utils";
import { CampaignEditor, type CampaignEditorValues } from "../campaign-editor";

export const metadata: Metadata = { title: "New campaign" };

type PageProps = { searchParams: Promise<{ starter?: string | string[] }> };

const BLANK_TEMPLATE = "{garage}: Hi {first_name}, ";

/** New campaign (P5.5): blank, or from a ready-made starting point (`?starter=winter_check`). */
export default async function NewCampaignPage({ searchParams }: PageProps) {
  const admin = await requireSetupContext("/app/campaigns/new");
  if (!garageHasFeature(admin.garage, "campaigns")) {
    return <ProLockedPage feature="campaigns" title="Campaigns" canUpgrade={admin.role === "owner"} />;
  }
  if (!roleAllows(admin, "manage")) redirect("/app/campaigns?error=not_allowed");

  const query = await searchParams;
  const requested = typeof query.starter === "string" ? query.starter : undefined;
  const starter = isCampaignStarter(requested) && (!STARTERS[requested].mot || admin.garage.motEnabled) ? requested : null;
  const timeZone = admin.garage.timezone || DEFAULT_TIME_ZONE;
  const today = localDateKey(new Date(), timeZone);
  const services = await loadCampaignServices(admin.client, admin.garage.id, admin.garage.motEnabled);

  const segment: CampaignSegment = starter ? starterSegment(starter, today) : {};
  const values: CampaignEditorValues = starter
    ? {
        starter,
        name: STARTERS[starter].name,
        segment,
        template: STARTERS[starter].template,
        emailSubject: STARTERS[starter].emailSubject,
        emailTemplate: "",
        serviceId: starterService(starter, services) ?? "",
      }
    : { name: "", segment, template: BLANK_TEMPLATE, emailSubject: `News from ${admin.garage.name}`.slice(0, 150), emailTemplate: "", serviceId: "" };
  const preview = await previewAudience(admin.client, segment, 8);

  return (
    <div className="flex flex-col gap-[22px] pb-10">
      <Link href="/app/campaigns" className={cn(textLinkClass, "inline-flex min-h-11 items-center gap-1.5 self-start text-[14px] font-semibold")}>
        <ArrowLeft size={16} strokeWidth={2} aria-hidden="true" />
        Campaigns
      </Link>
      <PageHeader
        title={starter ? `New campaign: ${STARTERS[starter].title}` : "New campaign"}
        description="Choose who gets it and write the message. You can send yourself a test and pick when it goes on the next step."
      />
      <CampaignEditor
        values={values}
        services={services}
        motEnabled={admin.garage.motEnabled}
        sampleValues={campaignSampleValues({ garageName: admin.garage.name, bookingBaseUrl: garageBaseUrl(admin.garage) })}
        senderName={admin.garage.name}
        initialPreview={preview.ok ? preview.preview : null}
      />
    </div>
  );
}
