import { NextResponse } from "next/server";
import { listPublicBookingServices } from "@/lib/bookings/services";
import { resolveRouteGarage } from "@/lib/tenancy/route";

export async function GET() {
  const { garage, response } = await resolveRouteGarage();
  if (response) return response;
  const services = await listPublicBookingServices(garage.id);
  return NextResponse.json({ services }, { headers: { "Cache-Control": "no-store" } });
}
