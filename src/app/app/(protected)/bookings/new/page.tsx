import type { Metadata } from "next";
import Link from "next/link";
import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { Tag } from "lucide-react";
import { buttonClass, EmptyState, PageHeader } from "@/components/admin-ui";
import { loadOpeningHours } from "@/lib/admin/data";
import { addDays, isoWeekday, localDateKey } from "@/lib/admin/dates";
import type { PriceMode, ServiceLocationMode } from "@/lib/booking-engine/types";
import { getAdminContext } from "@/lib/tenancy/admin";
import { NewBookingForm, type StaffService } from "./new-booking-form";

export const metadata: Metadata = { title: "New booking" };

type ServiceRow = {
  id: string;
  name: string;
  duration_min: number;
  price_pence: number | null;
  price_mode: PriceMode;
  location_mode: ServiceLocationMode;
  is_mot: boolean | null;
};

/**
 * Staff booking for a customer on the phone or at the counter (`source` phone / walk_in). Times
 * come from the booking engine, the same as the online booking page. Services are read through
 * the garage's RLS client.
 */
export default async function NewBookingPage() {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  if (!admin) redirect("/app/login");
  const timeZone = admin.garage.timezone || "Europe/London";
  const [{ data, error }, opening] = await Promise.all([
    admin.client
      .from("services")
      .select("id,name,duration_min,price_pence,price_mode,location_mode,is_mot")
      .is("deleted_at", null)
      .eq("online_enabled", true)
      .order("sort", { ascending: true })
      .order("name", { ascending: true }),
    loadOpeningHours(admin.client),
  ]);
  const services: StaffService[] = ((data ?? []) as ServiceRow[])
    // MOT services exist only for garages with MOT switched on.
    .filter((row) => admin.garage.motEnabled || !row.is_mot)
    .map((row) => ({ id: row.id, name: row.name, durationMin: row.duration_min, pricePence: row.price_pence, priceMode: row.price_mode, locationMode: row.location_mode }));
  const today = localDateKey(new Date(), timeZone);
  const days = Array.from({ length: 21 }, (_, index) => addDays(today, index));
  // Opening hours unknown: offer every day and let the engine say there are no times.
  const closedDays = opening.size > 0 ? days.filter((day) => !(opening.get(isoWeekday(day)) ?? []).length) : [];

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        eyebrow="Bookings"
        title="New booking"
        description="Book a customer in who rang or walked in. They get the same confirmation as an online booking."
      />
      {error ? (
        <div role="alert" className="rounded-card border border-[#f3c4c4] bg-[#fdecec] px-4 py-3.5 text-[14px] font-semibold text-[#991b1b]">
          Services could not be loaded. Refresh the page to try again.
        </div>
      ) : services.length === 0 ? (
        <EmptyState
          tone="card"
          icon={Tag}
          title="No bookable services yet"
          description="Add the services you offer, with their times and prices, and you can book customers in here."
          action={
            <Link href="/app/settings/services" className={buttonClass("secondary")}>
              Set up services
            </Link>
          }
        />
      ) : (
        <NewBookingForm services={services} days={days} closedDays={closedDays} timeZone={timeZone} idempotencyKey={randomUUID()} />
      )}
    </div>
  );
}
