import { NextResponse } from "next/server";
import { getBookingEnvironmentReadiness, getEnvironmentReadiness } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/server";
import { getVehicleLookupReadiness } from "@/lib/vehicle/configured-provider";

/**
 * Platform readiness for uptime checks. Reports booleans and statuses only:
 * no garage names, ids, hosts or counts.
 */
export async function GET() {
  const readiness = getEnvironmentReadiness();
  const vehicleLookup = getVehicleLookupReadiness();
  const bookingEnvironment = getBookingEnvironmentReadiness();
  const admin = createAdminClient();
  const supabaseConfigured = Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY && admin,
  );
  const garages = admin ? await admin.from("garages").select("id").limit(1) : null;
  const databaseReady = Boolean(garages && !garages.error);
  const hasGarage = Boolean(databaseReady && garages?.data?.length);
  const tenancyReady = supabaseConfigured && databaseReady && hasGarage;
  const ready = readiness.ready && tenancyReady;
  const missingIntegrations = readiness.missing.length + bookingEnvironment.missing.length + (databaseReady ? 0 : 1) + (hasGarage ? 0 : 1);

  return NextResponse.json(
    {
      status: ready ? "ready" : "configuration_required",
      checks: {
        website: ready ? "online" : "configuration_required",
        configuration: readiness.ready,
        database: databaseReady ? "connected" : "degraded",
        tenancy: {
          supabase: supabaseConfigured ? "configured" : "configuration_required",
          garages: hasGarage ? "ready" : "none",
          status: tenancyReady ? "ready" : "configuration_required",
        },
        email: readiness.ready ? "operational" : "configuration_required",
        bookingManagement: Boolean(process.env.BOOKING_MANAGEMENT_SECRET) ? "configured" : "configuration_required",
        bookingWebhook: Boolean(process.env.CALCOM_WEBHOOK_SECRET) ? "configured" : "configuration_required",
        // Source names only; never values or variable names.
        vehicleLookup: { status: vehicleLookup.status, provider: vehicleLookup.provider, sources: vehicleLookup.sources, cache: vehicleLookup.cache },
      },
      missingIntegrations,
    },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
