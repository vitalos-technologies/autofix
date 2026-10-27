import { Wrench } from "lucide-react";
import { formatPence } from "@/lib/invoices/money";
import { listGarageServices, type GarageService } from "@/lib/service-catalogue/repository";
import { getAdminContext } from "@/lib/tenancy/admin";

// Read-only until Setup → Services & prices (P3.4) adds editing.
export default async function AdminServiceCataloguePage() {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  const services = admin ? await listGarageServices(admin.client, admin.garage.id) : [];
  const online = services.filter((service) => service.onlineEnabled).length;

  return <>
    <header className="flex items-start gap-4">
      <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-[#EAF3FF] text-[#1974E2]"><Wrench size={23} aria-hidden="true" /></span>
      <div>
        <p className="text-xs font-extrabold tracking-widest text-[#1974E2] uppercase">Setup</p>
        <h1 className="mt-1 text-4xl font-extrabold text-[#071127]">Services</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-[#667586]">The services customers can book and that appear on invoices. Editing services, prices and durations arrives with Setup.</p>
      </div>
    </header>
    <div className="mt-7 grid gap-4 sm:grid-cols-2"><Summary label="Services" value={services.length} /><Summary label="Bookable online" value={online} /></div>
    <section className="mt-7 overflow-hidden rounded-2xl border border-[#E4EAF0] bg-white" aria-label="Services">
      {services.map((service) => (
        <div key={service.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-[#E4EAF0] px-5 py-4 first:border-t-0">
          <div className="min-w-0">
            <p className="font-extrabold text-[#071127]">{service.name}</p>
            <p className="mt-1 text-sm text-[#667586]">{service.durationMin} minutes · {priceLabel(service)} · {locationLabel(service)}</p>
          </div>
          <span className={service.onlineEnabled ? "rounded-full bg-green-100 px-3 py-1 text-xs font-extrabold text-green-800" : "rounded-full bg-[#E4EAF0] px-3 py-1 text-xs font-extrabold text-[#586575]"}>
            {service.onlineEnabled ? "Online" : "Staff only"}
          </span>
        </div>
      ))}
      {!services.length && <p className="px-5 py-8 text-sm text-[#667586]">No services yet.</p>}
    </section>
  </>;
}

function priceLabel(service: GarageService) {
  if (service.priceMode === "quote" || service.pricePence === null) return "Price on quote";
  return service.priceMode === "from" ? `From ${formatPence(service.pricePence)}` : formatPence(service.pricePence);
}

function locationLabel(service: GarageService) {
  return service.locationMode === "both" ? "Workshop or mobile" : service.locationMode === "mobile" ? "Mobile" : "Workshop";
}

function Summary({ label, value }: { label: string; value: number }) {
  return <article className="rounded-2xl border border-[#E4EAF0] bg-white p-5"><p className="text-3xl font-extrabold text-[#071127]">{value}</p><p className="mt-1 text-sm font-bold text-[#667586]">{label}</p></article>;
}
