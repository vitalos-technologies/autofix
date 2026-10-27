import type { Metadata } from "next";
import { buttonClass } from "@/components/admin-ui/styles";
import { formatServicePrice } from "@/components/book/format";
import { SubmitButton } from "@/components/admin-ui/submit-button";
import { Notice } from "@/components/onboarding/field";
import { OnboardingFrame } from "@/components/onboarding/onboarding-frame";
import { ONBOARDING_PATHS } from "@/components/onboarding/steps";
import type { PriceMode } from "@/lib/booking-engine/types";
import { saveOnboardingServicesAction } from "../actions";
import { requireOnboardingOwner } from "../context";

export const metadata: Metadata = { title: "Services and MOT" };

const ERRORS: Record<string, string> = {
  save_failed: "Your choices could not be saved. Try again.",
  none_kept: "Keep at least one service so customers can book.",
};

type ServiceRow = { id: string; name: string; description: string | null; duration_min: number; price_pence: number | null; price_mode: PriceMode; is_mot: boolean; deleted_at: string | null };

/** Step 4: MOT on or off, and the starting service list (the defaults seed_garage_defaults() added). */
export default async function OnboardingServicesPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const admin = await requireOnboardingOwner(ONBOARDING_PATHS.services);
  const { error } = await searchParams;
  const { data } = await admin.client
    .from("services")
    .select("id,name,description,duration_min,price_pence,price_mode,is_mot,deleted_at")
    .eq("garage_id", admin.garage.id)
    .order("sort", { ascending: true });
  const services = (data ?? []) as ServiceRow[];
  const mot = services.find((service) => service.is_mot);
  const others = services.filter((service) => !service.is_mot);

  return (
    <OnboardingFrame step={4} title="Services and MOT" description="We've added common services with typical prices and times. Keep the ones you offer; change prices and times later in Setup.">
      {error && ERRORS[error] ? <Notice tone="error" role="alert">{ERRORS[error]}</Notice> : null}
      <form action={saveOnboardingServicesAction} className="flex flex-col gap-5">
        <fieldset className="m-0 flex flex-col gap-3 rounded-card border border-grey-200 bg-white p-5">
          <legend className="float-left mb-1 p-0 text-[17px] font-bold text-navy-950">Do you do MOTs?</legend>
          <p className="clear-both m-0 text-[14px] leading-5 text-grey-600">
            With MOT on, customers see MOT due dates and can book an MOT{mot ? ` (${formatServicePrice(mot.price_pence, mot.price_mode)})` : ""}, and MOT reminders go out.
          </p>
          {[{ value: "yes", label: "Yes, we're an MOT test centre" }, { value: "no", label: "No, we don't do MOTs" }].map((option) => (
            <label key={option.value} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-[12px] border border-grey-300 px-3.5 has-[:checked]:border-2 has-[:checked]:border-accent">
              <input type="radio" name="mot" value={option.value} defaultChecked={(option.value === "yes") === admin.garage.motEnabled} className="size-5 accent-[var(--garage-accent)]" />
              <span className="text-[15px] font-semibold text-navy-950">{option.label}</span>
            </label>
          ))}
        </fieldset>

        <fieldset className="m-0 flex flex-col gap-3 rounded-card border border-grey-200 bg-white p-5">
          <legend className="float-left mb-1 p-0 text-[17px] font-bold text-navy-950">Services customers can book</legend>
          <div className="clear-both flex flex-col gap-2">
            {others.map((service) => (
              <label key={service.id} className="flex min-h-14 cursor-pointer items-start gap-3 rounded-[12px] border border-grey-300 p-3.5 has-[:checked]:border-accent">
                <input type="checkbox" name="service" value={service.id} defaultChecked={service.deleted_at === null} className="mt-0.5 size-5 shrink-0 accent-[var(--garage-accent)]" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-[15px] font-semibold text-navy-950">{service.name}</span>
                    <span className="text-[14px] font-semibold text-grey-700">{formatServicePrice(service.price_pence, service.price_mode)}</span>
                  </span>
                  <span className="text-[13px] leading-5 text-grey-600">{service.description} {service.duration_min} min.</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <SubmitButton className={buttonClass("primary", "md", "min-h-[54px] w-full text-[16px]")}>Save and continue</SubmitButton>
      </form>
    </OnboardingFrame>
  );
}
