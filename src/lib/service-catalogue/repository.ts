import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PriceMode, ServiceLocationMode } from "@/lib/booking-engine/types";

// A garage's services (`services`, P2.1), for admin lists and invoice line
// items. The Cal.com-era catalogue (vehicle systems + event-type mappings) is
// gone; services are edited in Setup (P3.4). Admin pages pass their RLS garage
// client and every query is still filtered by `garage_id`.

export type GarageService = {
  id: string;
  name: string;
  description: string;
  durationMin: number;
  pricePence: number | null;
  priceMode: PriceMode;
  locationMode: ServiceLocationMode;
  onlineEnabled: boolean;
  isMot: boolean;
  sort: number;
};

/** Services grouped for pickers (the invoice form). One group per garage for now. */
export type CatalogueSystem = {
  id: string;
  key: string;
  name: string;
  description: string;
  sortOrder: number;
  services: GarageService[];
};

type ServiceRow = {
  id: string;
  name: string;
  description: string | null;
  duration_min: number;
  price_pence: number | null;
  price_mode: PriceMode;
  location_mode: ServiceLocationMode;
  online_enabled: boolean | null;
  is_mot: boolean | null;
  sort: number | null;
};

export async function listGarageServices(client: SupabaseClient | null, garageId: string): Promise<GarageService[]> {
  if (!client || !garageId) return [];
  const { data, error } = await client
    .from("services")
    .select("id,name,description,duration_min,price_pence,price_mode,location_mode,online_enabled,is_mot,sort")
    .eq("garage_id", garageId)
    .is("deleted_at", null)
    .order("sort", { ascending: true })
    .order("name", { ascending: true });
  if (error || !data) return [];
  return (data as ServiceRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    durationMin: row.duration_min,
    pricePence: row.price_pence,
    priceMode: row.price_mode,
    locationMode: row.location_mode,
    onlineEnabled: Boolean(row.online_enabled),
    isMot: Boolean(row.is_mot),
    sort: row.sort ?? 0,
  }));
}

/** The garage's services as one picker group (empty when it has none). */
export async function listServiceCatalogue(client: SupabaseClient | null, garageId: string): Promise<CatalogueSystem[]> {
  const services = await listGarageServices(client, garageId);
  if (!services.length) return [];
  return [{ id: "services", key: "services", name: "Services", description: "", sortOrder: 0, services }];
}
