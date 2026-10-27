import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PriceModeValue, ServiceLocationValue } from "@/lib/settings/setup";

export type SetupService = {
  id: string;
  name: string;
  description: string;
  durationMin: number;
  bufferMin: number;
  pricePence: number | null;
  priceMode: PriceModeValue;
  locationMode: ServiceLocationValue;
  resourceKind: "bay" | "mobile" | "technician";
  onlineEnabled: boolean;
  needsApproval: boolean;
  minNoticeH: number;
  maxDaysAhead: number;
  isMot: boolean;
  sort: number;
  deletedAt: string | null;
};

export const LOCATION_LABELS: Record<ServiceLocationValue, string> = {
  workshop: "Workshop",
  mobile: "Mobile visit",
  both: "Workshop or mobile",
};

const COLUMNS = "id,name,description,duration_min,buffer_min,price_pence,price_mode,location_mode,resource_kind,online_enabled,needs_approval,min_notice_h,max_days_ahead,is_mot,sort,deleted_at";

type ServiceRow = {
  id: string;
  name: string;
  description: string | null;
  duration_min: number;
  buffer_min: number | null;
  price_pence: number | null;
  price_mode: PriceModeValue;
  location_mode: ServiceLocationValue;
  resource_kind: SetupService["resourceKind"];
  online_enabled: boolean | null;
  needs_approval: boolean | null;
  min_notice_h: number | null;
  max_days_ahead: number | null;
  is_mot: boolean | null;
  sort: number | null;
  deleted_at: string | null;
};

function fromRow(row: ServiceRow): SetupService {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    durationMin: row.duration_min,
    bufferMin: row.buffer_min ?? 0,
    pricePence: row.price_pence,
    priceMode: row.price_mode,
    locationMode: row.location_mode,
    resourceKind: row.resource_kind,
    onlineEnabled: Boolean(row.online_enabled),
    needsApproval: Boolean(row.needs_approval),
    minNoticeH: row.min_notice_h ?? 2,
    maxDaysAhead: row.max_days_ahead ?? 60,
    isMot: Boolean(row.is_mot),
    sort: row.sort ?? 0,
    deletedAt: row.deleted_at,
  };
}

/** The selected garage's services (RLS client): live ones in booking-page order, then archived ones, newest first. */
export async function loadServices(client: SupabaseClient, garageId: string): Promise<{ active: SetupService[]; archived: SetupService[] }> {
  const { data, error } = await client
    .from("services")
    .select(COLUMNS)
    .eq("garage_id", garageId)
    .order("sort", { ascending: true })
    .order("name", { ascending: true });
  if (error || !data) return { active: [], archived: [] };
  const services = (data as ServiceRow[]).map(fromRow);
  return {
    active: services.filter((service) => !service.deletedAt),
    archived: services
      .filter((service) => service.deletedAt)
      .sort((left, right) => String(right.deletedAt).localeCompare(String(left.deletedAt))),
  };
}

/** One live service of the selected garage, or null. */
export async function loadService(client: SupabaseClient, garageId: string, id: string): Promise<SetupService | null> {
  const { data, error } = await client.from("services").select(COLUMNS).eq("garage_id", garageId).eq("id", id).is("deleted_at", null).maybeSingle();
  if (error || !data) return null;
  return fromRow(data as ServiceRow);
}
