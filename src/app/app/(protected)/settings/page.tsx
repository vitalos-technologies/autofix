import { Bell, Building2, Clock3, Contact, HeartPulse, MapPin } from "lucide-react";
import Link from "next/link";
import { saveSettings } from "../actions";
import { AdminField } from "@/components/admin/admin-field";
import { OpeningHoursEditor } from "@/components/admin/opening-hours-editor";
import { getAdminContext } from "@/lib/tenancy/admin";
import { formatPhoneForDisplay } from "@/lib/tenancy/contact";

const emptyOpeningHours = { monday: "", tuesday: "", wednesday: "", thursday: "", friday: "", saturday: "", sunday: "", bankHolidays: "" };

const errorMessages: Record<string, string> = {
  owner_only: "Only a garage owner can change these details.",
  invalid: "Check the details and try again.",
  phone: "Enter UK phone numbers, for example 01302 000101 or 07700 900123.",
  save_failed: "The settings could not be saved. Try again.",
};

// Garage profile for the admin's selected garage. Facts come from `garages`;
// opening-hours text lives in that garage's `site_settings` row until P3.4.
export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  const { saved, error } = await searchParams;
  const { data } = admin
    ? await admin.client.from("site_settings").select("value").eq("garage_id", admin.garage.id).maybeSingle()
    : { data: null };
  const stored = (data?.value || {}) as { openingHours?: Partial<typeof emptyOpeningHours>; googleMapsUrl?: string };
  const garage = admin?.garage;
  const current = {
    name: garage?.name ?? "",
    legalName: garage?.legalName ?? "",
    companyNumber: garage?.companyNumber ?? "",
    phone: formatPhoneForDisplay(garage?.phone),
    whatsapp: formatPhoneForDisplay(garage?.whatsapp),
    email: garage?.email ?? "",
    address: { line1: garage?.address.line1 ?? "", line2: garage?.address.line2 ?? "", town: garage?.address.town ?? "", postcode: garage?.address.postcode ?? "" },
    openingHours: { ...emptyOpeningHours, ...(stored.openingHours || {}) },
    googleMapsUrl: typeof stored.googleMapsUrl === "string" ? stored.googleMapsUrl : "",
  };
  const canEdit = admin?.role === "owner";

  return (
    <>
      <p className="text-xs font-extrabold tracking-widest text-[#1974E2] uppercase">Configuration</p>
      <h1 className="mt-2 text-4xl font-extrabold text-[#071127]">Settings</h1>
      <p className="mt-3 text-[#586575]">Manage the details {current.name || "your garage"} shows on its booking page, emails and invoices.</p>
      {saved === "1" && <p role="status" className="mt-5 rounded-xl border border-green-200 bg-green-50 p-4 text-sm font-bold text-green-800">Settings saved.</p>}
      {error && errorMessages[error] && <p role="alert" className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm font-bold text-amber-900">{errorMessages[error]}</p>}
      {!canEdit && <p className="mt-5 rounded-xl border border-[#D7E0E9] bg-white p-4 text-sm text-[#586575]">Only a garage owner can change these details.</p>}

      <nav aria-label="Configuration pages" className="mt-6 flex w-fit gap-1 rounded-xl border border-[#D7E0E9] bg-white p-1">
        <Link href="/app/settings" aria-current="page" className="rounded-lg bg-[#071127] px-4 py-2 text-sm font-bold text-white">Settings</Link>
        <Link href="/app/configuration/security" className="rounded-lg px-4 py-2 text-sm font-bold text-[#586575] hover:bg-[#F4F7FA] hover:text-[#1974E2]">Security</Link>
        <Link href="/app/settings/agreements" className="rounded-lg px-4 py-2 text-sm font-bold text-[#586575] hover:bg-[#F4F7FA] hover:text-[#1974E2]">Agreements</Link>
      </nav>

      <div className="mt-8 grid items-start gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="rounded-2xl border border-[#E4EAF0] bg-white p-2 lg:sticky lg:top-6">
          <p className="px-3 pb-2 pt-2 text-[0.65rem] font-extrabold uppercase tracking-[0.16em] text-[#8794A3]">General</p>
          <SettingsLink href="#business-profile" label="Business profile" icon={<Building2 />} active />
          <SettingsLink href="#contact-details" label="Contact details" icon={<Contact />} />
          <SettingsLink href="#location" label="Location" icon={<MapPin />} />
          <SettingsLink href="#opening-hours" label="Opening hours" icon={<Clock3 />} />

          <p className="mt-4 px-3 pb-2 text-[0.65rem] font-extrabold uppercase tracking-[0.16em] text-[#8794A3]">Operations</p>
          <SettingsLink href="#notification-settings" label="Notifications" icon={<Bell />} />
          <SettingsLink href="#system-settings" label="System health" icon={<HeartPulse />} />
        </nav>

        <div className="min-w-0">
          <form action={saveSettings} className="grid gap-6">
            <SettingsSection id="business-profile" icon={<Building2 />} title="Business profile" description="Core identity and registration details shown throughout the site.">
              <AdminField label="Business name"><input name="name" required defaultValue={current.name} /></AdminField>
              <AdminField label="Legal name"><input name="legalName" defaultValue={current.legalName} /></AdminField>
              <AdminField label="Company number"><input name="companyNumber" defaultValue={current.companyNumber} /></AdminField>
            </SettingsSection>

            <SettingsSection id="contact-details" icon={<Contact />} title="Contact details" description="Public channels customers use to contact the garage.">
              <AdminField label="Phone"><input name="phone" type="tel" autoComplete="tel" defaultValue={current.phone} /></AdminField>
              <AdminField label="WhatsApp"><input name="whatsapp" type="tel" defaultValue={current.whatsapp} /></AdminField>
              <AdminField label="Email"><input name="email" type="email" autoComplete="email" defaultValue={current.email} /></AdminField>
            </SettingsSection>

            <SettingsSection id="location" icon={<MapPin />} title="Location" description="Workshop address and the destination used by map links.">
              <AdminField label="Address line 1"><input name="line1" autoComplete="address-line1" defaultValue={current.address.line1} /></AdminField>
              <AdminField label="Address line 2"><input name="line2" autoComplete="address-line2" defaultValue={current.address.line2} /></AdminField>
              <AdminField label="Town"><input name="town" autoComplete="address-level2" defaultValue={current.address.town} /></AdminField>
              <AdminField label="Postcode"><input name="postcode" autoComplete="postal-code" defaultValue={current.address.postcode} /></AdminField>
              <AdminField label="Google Maps URL"><input name="googleMapsUrl" type="url" defaultValue={current.googleMapsUrl} /></AdminField>
            </SettingsSection>

            <SettingsSection id="opening-hours" icon={<Clock3 />} title="Opening hours" description="Leave an entry blank when the hours are not confirmed; blank hours are not published.">
              <OpeningHoursEditor initialHours={current.openingHours} />
            </SettingsSection>

            <div className="sticky bottom-4 z-10 flex justify-end rounded-2xl border border-[#D7E0E9] bg-white/95 p-4 shadow-[0_12px_35px_rgba(7,17,39,0.12)] backdrop-blur">
              <button disabled={!canEdit} className="min-h-12 w-full rounded-xl bg-[#1974E2] px-7 font-bold text-white disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto">Save all settings</button>
            </div>
          </form>

          <div className="mt-6 grid gap-6">
            <ManagementSection id="notification-settings" icon={<Bell />} title="Notifications" description="Review new enquiries, pending messages and email delivery issues requiring attention." href="/app/notifications" action="Review notifications" />
            <ManagementSection id="system-settings" icon={<HeartPulse />} title="System health" description="Check integration readiness for the database, email, booking and vehicle lookup." href="/app#system-health" action="View system health" />
          </div>

        </div>
      </div>
    </>
  );
}

function SettingsLink({ href, label, icon, active = false }: { href: string; label: string; icon: React.ReactNode; active?: boolean }) {
  const className = `flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-bold transition-colors ${active ? "bg-[#071127] text-white" : "text-[#586575] hover:bg-[#F4F7FA] hover:text-[#1974E2]"}`;
  return <a href={href} className={className}><span className="[&_svg]:size-[17px]" aria-hidden="true">{icon}</span>{label}</a>;
}

function ManagementSection({ id, icon, title, description, href, action }: { id: string; icon: React.ReactNode; title: string; description: string; href: string; action: string }) {
  return (
    <section id={id} className="scroll-mt-6 rounded-2xl border border-[#E4EAF0] bg-white p-6" aria-labelledby={`${id}-heading`}>
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-center">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#EAF3FF] text-[#1974E2] [&_svg]:size-5" aria-hidden="true">{icon}</span>
          <div><h2 id={`${id}-heading`} className="text-xl font-bold text-[#071127]">{title}</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-[#586575]">{description}</p></div>
        </div>
        <Link href={href} className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl border border-[#BCD6F6] px-4 text-sm font-bold text-[#1974E2] hover:bg-[#EAF3FF]">{action}</Link>
      </div>
    </section>
  );
}

function SettingsSection({ id, icon, title, description, children }: { id: string; icon: React.ReactNode; title: string; description: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 rounded-2xl border border-[#E4EAF0] bg-white p-6" aria-labelledby={`${id}-heading`}>
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#EAF3FF] text-[#1974E2] [&_svg]:size-5" aria-hidden="true">{icon}</span>
        <div><h2 id={`${id}-heading`} className="text-xl font-bold text-[#071127]">{title}</h2><p className="mt-1 text-sm leading-6 text-[#586575]">{description}</p></div>
      </div>
      <div className="mt-6 grid gap-5 md:grid-cols-2">{children}</div>
    </section>
  );
}
