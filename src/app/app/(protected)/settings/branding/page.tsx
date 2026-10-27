import type { Metadata } from "next";
import Link from "next/link";
import { buttonClass, PageHeader, Panel, Switch } from "@/components/admin-ui";
import { garageInitials } from "@/components/book";
import { accentForWhiteText } from "@/lib/branding/accent";
import { canChangeGarage } from "@/lib/settings/setup";
import { getAdminContext } from "@/lib/tenancy/admin";
import { FlashMessage, ReadOnlyNotice, SetupNav, SetupNotice } from "../_components/setup-nav";
import { removeLogoAction, setMotEnabledAction } from "./actions";
import { AccentPicker, BrandingPreview, BrandingPreviewProvider, LogoForm } from "./branding-studio";

export const metadata: Metadata = { title: "Branding & MOT" };

const MESSAGES: Record<string, string> = {
  "done:logo_removed": "Logo removed. Your booking page shows your initials instead.",
  "done:mot_on": "MOT is on. Your MOT services show on the booking page, with MOT due dates and reminders.",
  "done:mot_off": "MOT is off. MOT services, MOT due dates and MOT reminders are hidden.",
  "error:not_allowed": "Only the garage owner can change branding and MOT.",
  "error:save_failed": "That change could not be saved. Try again.",
};

type PageProps = { searchParams: Promise<{ done?: string | string[]; error?: string | string[] }> };

/** Setup · Branding & MOT: logo, brand colour with a contrast check and live preview, and MOT on/off. */
export default async function BrandingSetupPage({ searchParams }: PageProps) {
  const admin = await getAdminContext({ allowTrustedDevice: true });
  const query = await searchParams;
  const garage = admin?.garage;
  const canEdit = canChangeGarage(admin?.role);
  const motServices = admin
    ? await admin.client.from("services").select("id").eq("garage_id", admin.garage.id).eq("is_mot", true).is("deleted_at", null).eq("online_enabled", true)
    : null;
  const hasMotService = Boolean(motServices?.data?.length);
  const name = garage?.name ?? "Your garage";
  const accent = garage?.accent ?? "#155fba";
  const motEnabled = garage?.motEnabled ?? false;
  const logoUrl = garage?.logoUrl ?? null;

  return (
    <div className="flex flex-col gap-5 pb-10">
      <PageHeader eyebrow="Setup" title="Branding & MOT" description="How your booking page looks to customers, and whether you offer MOTs." />
      <SetupNav current="branding" />
      <FlashMessage messages={MESSAGES} done={query.done} error={query.error} />
      {!canEdit ? <ReadOnlyNotice level="owner" /> : null}

      <BrandingPreviewProvider initialAccent={accent}>
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-w-0 flex-col gap-5">
            <Panel id="logo" title="Logo">
              <div className="flex flex-wrap items-center gap-3">
                {logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- the garage's own uploaded file
                  <img src={logoUrl} alt={`${name} logo`} className="size-14 rounded-[14px] border border-grey-200 bg-white object-contain" />
                ) : (
                  <span
                    aria-hidden="true"
                    style={{ background: accentForWhiteText(accent) }}
                    className="flex size-14 items-center justify-center rounded-[14px] font-display text-[26px] font-extrabold text-white"
                  >
                    {garageInitials(name)}
                  </span>
                )}
                <p className="m-0 min-w-0 flex-[1_1_200px] text-[14px] text-grey-600">
                  {logoUrl ? "Shown in the header of every booking step." : "No logo yet: the booking page shows your initials in your brand colour."}
                </p>
                {logoUrl && canEdit ? (
                  <form action={removeLogoAction}>
                    <button type="submit" className={buttonClass("secondary", "sm")}>
                      Remove logo
                    </button>
                  </form>
                ) : null}
              </div>
              {canEdit ? <LogoForm canEdit={canEdit} hasLogo={Boolean(logoUrl)} /> : null}
            </Panel>

            <Panel id="colour" title="Brand colour">
              <p className="m-0 text-[14px] text-grey-600">
                Used for buttons, selected times and links on your booking page. Colours that white text can&apos;t be read on are darkened automatically.
              </p>
              <AccentPicker savedAccent={accent} canEdit={canEdit} />
              {/* Phones: the preview sits right under the picker; wide screens show it beside the page. */}
              <div className="flex flex-col gap-2 lg:hidden">
                <h3 className="m-0 font-sans text-[15px] font-bold tracking-normal text-navy-950">Preview</h3>
                <BrandingPreview garageName={name} logoUrl={logoUrl} />
              </div>
            </Panel>

            <Panel id="mot" title="MOT">
              <div className="flex items-start gap-3">
                <div className="flex min-w-0 grow flex-col gap-1">
                  <span id="mot-label" className="text-[15px] font-bold text-navy-950">
                    Offer MOTs <span className="font-semibold text-grey-600">· {motEnabled ? "On" : "Off"}</span>
                  </span>
                  <p id="mot-description" className="m-0 text-[14px] leading-snug text-grey-600">
                    When on, your MOT services appear on the booking page, customers see when their car&apos;s MOT is due, and MOT reminders can be sent.
                    When off, MOT services and MOT reminders are hidden.
                  </p>
                </div>
                <form action={setMotEnabledAction} className="flex shrink-0">
                  <input type="hidden" name="enabled" value={String(!motEnabled)} />
                  <Switch type="submit" label="Offer MOTs" checked={motEnabled} disabled={!canEdit} describedBy="mot-description" />
                </form>
              </div>
              {motEnabled && !hasMotService ? (
                <SetupNotice tone="warning">
                  MOT is on, but you have no MOT service customers can book.{" "}
                  <Link href="/app/settings/services/new" className="font-semibold text-warning-ink underline underline-offset-2">
                    Add an MOT service
                  </Link>
                </SetupNotice>
              ) : null}
            </Panel>
          </div>

          <aside aria-labelledby="preview-title" className="hidden lg:sticky lg:top-6 lg:block">
            <Panel>
              <h2 id="preview-title" className="m-0 font-sans text-[17px] font-bold tracking-normal text-navy-950">
                Preview
              </h2>
              <p className="m-0 text-[13px] text-grey-600">The first booking step, in the colour you are trying.</p>
              <BrandingPreview garageName={name} logoUrl={logoUrl} />
            </Panel>
          </aside>
        </div>
      </BrandingPreviewProvider>
    </div>
  );
}
