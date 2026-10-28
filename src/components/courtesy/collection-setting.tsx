import type { SupabaseClient } from "@supabase/supabase-js";
import { Panel, Switch } from "@/components/admin-ui";
import { ProBadge } from "@/components/plans/pro-locked";
import { garageHasFeature } from "@/lib/plans/server";
import type { Garage } from "@/lib/tenancy/garage";
import { setServiceCollectionAction } from "@/app/app/(protected)/courtesy-cars/actions";
import { CourtesyNotice } from "./courtesy-ui";

const MESSAGES: Record<string, { tone: "success" | "error"; text: string }> = {
  on: { tone: "success", text: "Collection and delivery is on for this service." },
  off: { tone: "success", text: "Collection and delivery is off for this service." },
  plan: { tone: "error", text: "Collection and delivery is on Pro. Ask the garage owner to upgrade." },
  not_allowed: { tone: "error", text: "Only the garage's owners and managers can change this." },
  not_found: { tone: "error", text: "That service could not be found. It may have been changed in another tab." },
  failed: { tone: "error", text: "That change could not be saved. Try again." },
};

/**
 * P5.8 on Setup · Services · Edit: the per-service "Collection and delivery" switch. On: a workshop
 * booking of this service can add collection before and delivery after, holding the mobile van
 * (Bays & vans) for each run, inside the mobile service area.
 */
export async function CollectionDeliverySetting({
  client,
  garage,
  serviceId,
  canEdit,
  flash,
}: {
  client: SupabaseClient;
  garage: Garage;
  serviceId: string;
  canEdit: boolean;
  flash?: string;
}) {
  const { data } = await client.from("services").select("collection_delivery,location_mode").eq("garage_id", garage.id).eq("id", serviceId).maybeSingle();
  if (!data) return null;
  const row = data as { collection_delivery: boolean; location_mode: string };
  const pro = garageHasFeature(garage, "courtesy_cars");
  if (!pro && !row.collection_delivery) {
    // Essentials: say what it is, without a control.
    return (
      <Panel id="collection-delivery" title={<span className="inline-flex items-center gap-2">Collection and delivery <ProBadge /></span>}>
        <p className="m-0 text-[14px] text-grey-700">Collect the customer&apos;s car before the job and bring it back after, with your van. Part of Pro.</p>
      </Panel>
    );
  }
  const notice = flash ? (MESSAGES[flash] ?? null) : null;
  const mobileOnly = row.location_mode === "mobile";
  return (
    <Panel id="collection-delivery" title="Collection and delivery">
      <CourtesyNotice flash={notice} />
      {mobileOnly ? (
        <p className="m-0 text-[14px] text-grey-700">This is a mobile-only service: the van already goes to the customer, so there is nothing to collect.</p>
      ) : (
        <>
          <p id="collection-delivery-hint" className="m-0 text-[14px] leading-normal text-grey-700">
            We collect the car before the job and bring it back after. Each run holds a mobile van from Bays &amp; vans for twice your travel time, and only
            postcodes in your mobile area can choose it. Customers see &ldquo;Collect and deliver my car&rdquo; when they book online.
          </p>
          <form action={setServiceCollectionAction} className="flex items-center gap-3">
            <input type="hidden" name="serviceId" value={serviceId} />
            <input type="hidden" name="enabled" value={String(!row.collection_delivery)} />
            <Switch type="submit" label="Offer collection and delivery" checked={row.collection_delivery} disabled={!canEdit || (!pro && !row.collection_delivery)} describedBy="collection-delivery-hint" />
            <span className="text-[14px] font-semibold text-navy-950">{row.collection_delivery ? "Offered" : "Not offered"}</span>
          </form>
        </>
      )}
    </Panel>
  );
}
