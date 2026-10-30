"use client";

import { Check, LoaderCircle, MapPin, Search } from "lucide-react";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { buttonClass } from "@/components/admin-ui/styles";
import { Notice, TextField } from "@/components/onboarding/field";
import { OnboardingProgress } from "@/components/onboarding/onboarding-progress";
import { describeOpeningHours } from "@/lib/places/map";
import type { PlaceOpeningWindow, PlaceSummary } from "@/lib/places/types";
import { parseGarageDetails, type FieldErrors, type GarageField } from "@/lib/signup/schema";
import { slugify } from "@/lib/signup/slug";
import { cn } from "@/lib/utils";
import { checkSlugAction, createGarageAction, placeDetailsAction, searchPlacesAction, type CreateGarageState, type SlugCheckResult } from "./actions";

type Details = { name: string; phone: string; email: string; website: string; line1: string; line2: string; town: string; postcode: string };

const EMPTY: Details = { name: "", phone: "", email: "", website: "", line1: "", line2: "", town: "", postcode: "" };
const STEP_ONE_FIELDS: GarageField[] = ["name", "phone", "email", "website", "line1", "line2", "town", "postcode", "placeId", "openingHours"];
const initialCreateState: CreateGarageState = { seq: 0, errors: {} };
/**
 * Typing in the link box checks the slug once the owner pauses. Server actions run one at a time per
 * client, so a check per keystroke queued every one of them and kept "Create my garage" disabled for
 * seconds after the last key. A change after a quiet spell (a paste, the first edit) is checked at once.
 */
const SLUG_CHECK_DELAY_MS = 300;

export type GarageWizardProps = {
  placesEnabled: boolean;
  /** The free link with `__slug__` where the slug goes, e.g. `https://__slug__.pitline.co.uk`. */
  linkTemplate: string;
  ownerEmail: string;
};

function nationalPhone(e164: string | null) {
  if (!e164?.startsWith("+44")) return e164 ?? "";
  const national = `0${e164.slice(3)}`;
  return national.length === 11 ? `${national.slice(0, 5)} ${national.slice(5)}` : national;
}

/** Steps 1 (find or enter the garage) and 2 (booking link). One server call creates the garage at the end. */
export function GarageWizard({ placesEnabled, linkTemplate, ownerEmail }: GarageWizardProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [details, setDetails] = useState<Details>({ ...EMPTY, email: ownerEmail });
  const [errors, setErrors] = useState<FieldErrors<GarageField>>({});
  const [placeId, setPlaceId] = useState("");
  const [hours, setHours] = useState<PlaceOpeningWindow[]>([]);
  const [useHours, setUseHours] = useState(true);
  // Uncontrolled: text typed before hydration (slow phones) stays in the box and is what Search sends.
  const queryRef = useRef<HTMLInputElement>(null);
  const [results, setResults] = useState<PlaceSummary[] | null>(null);
  const [placesMessage, setPlacesMessage] = useState("");
  const [searching, startSearch] = useTransition();
  const [loadingPlace, startPlace] = useTransition();
  const [picked, setPicked] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugCheck, setSlugCheck] = useState<SlugCheckResult | null>(null);
  const [checking, startCheck] = useTransition();
  const [checkDue, setCheckDue] = useState(false);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSlugChange = useRef(0);
  const [state, formAction, creating] = useActionState(createGarageAction, initialCreateState);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const checkSeq = useRef(0);

  const set = (field: keyof Details) => (event: React.ChangeEvent<HTMLInputElement>) => setDetails((current) => ({ ...current, [field]: event.target.value }));

  // Server-side errors on step 1 fields send the owner back to that step (adjusted during render).
  const [handledSeq, setHandledSeq] = useState(0);
  if (state.seq !== handledSeq) {
    setHandledSeq(state.seq);
    if (STEP_ONE_FIELDS.some((field) => state.errors[field])) {
      setErrors(state.errors);
      setStep(1);
    }
  }
  useEffect(() => {
    if (!state.seq) return;
    requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>("[aria-invalid='true'], [data-form-message]")?.focus());
  }, [state]);

  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  useEffect(() => () => {
    if (checkTimer.current) clearTimeout(checkTimer.current);
  }, []);

  function runSearch() {
    setPlacesMessage("");
    startSearch(async () => {
      const result = await searchPlacesAction(queryRef.current?.value ?? "");
      if (!result.ok) {
        setResults(null);
        setPlacesMessage(result.message);
        return;
      }
      setResults(result.results);
      if (!result.results.length) setPlacesMessage("No garages matched. Try your garage's name and town, or enter your details below.");
    });
  }

  function pick(place: PlaceSummary) {
    setPicked(place.id);
    setPlacesMessage("");
    startPlace(async () => {
      const result = await placeDetailsAction(place.id);
      if (!result.ok) {
        setPlacesMessage(result.message);
        return;
      }
      const found = result.place;
      setPlaceId(found.id);
      setHours(found.openingHours);
      setUseHours(found.openingHours.length > 0);
      setDetails((current) => ({
        ...current,
        name: found.name,
        phone: nationalPhone(found.phone) || current.phone,
        website: found.website ?? current.website,
        line1: found.address.line1 || current.line1,
        line2: found.address.line2,
        town: found.address.town || current.town,
        postcode: found.address.postcode || current.postcode,
      }));
      setErrors({});
    });
  }

  function cancelPendingCheck() {
    if (checkTimer.current) clearTimeout(checkTimer.current);
    checkTimer.current = null;
    setCheckDue(false);
  }

  function checkSlug(value: string) {
    cancelPendingCheck();
    const seq = ++checkSeq.current;
    startCheck(async () => {
      const result = await checkSlugAction(value, details.town);
      if (seq === checkSeq.current) setSlugCheck(result);
    });
  }

  /** Checks `value` once typing pauses; a newer value replaces it, and older answers are ignored. */
  function checkSlugSoon(value: string) {
    cancelPendingCheck();
    checkSeq.current += 1;
    setCheckDue(true);
    checkTimer.current = setTimeout(() => checkSlug(value), SLUG_CHECK_DELAY_MS);
  }

  function continueToLink() {
    const parsed = parseGarageDetails(details);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus());
      return;
    }
    setErrors({});
    const candidate = slugTouched && slug ? slug : slugify(details.name);
    setSlug(candidate);
    setSlugCheck(null);
    if (candidate) checkSlug(candidate);
    setStep(2);
  }

  function changeSlug(value: string, { immediate = false } = {}) {
    const next = value.toLowerCase().replace(/\s+/g, "-");
    setSlug(next);
    setSlugTouched(true);
    setSlugCheck(null);
    const now = Date.now();
    const quiet = !checkTimer.current && now - lastSlugChange.current >= SLUG_CHECK_DELAY_MS;
    lastSlugChange.current = now;
    if (next.length < 3) cancelPendingCheck();
    else if (immediate || quiet) checkSlug(next);
    else checkSlugSoon(next);
  }

  const slugError = state.errors.slug ?? (slugCheck && slugCheck.slug === slug && slugCheck.status !== "available" ? slugCheck.message : undefined);
  const slugOk = slugCheck?.slug === slug && slugCheck.status === "available";
  const preview = linkTemplate.replace("__slug__", slug || "your-garage");

  return (
    <form ref={formRef} action={formAction} noValidate className="flex flex-col gap-5">
      <OnboardingProgress step={step} />
      {/* Step 1's values travel with the final post. */}
      {(Object.keys(details) as Array<keyof Details>).map((field) => (step === 2 ? <input key={field} type="hidden" name={field} value={details[field]} /> : null))}
      <input type="hidden" name="placeId" value={placeId} />
      <input type="hidden" name="openingHours" value={JSON.stringify(hours)} />
      <input type="hidden" name="useOpeningHours" value={useHours && hours.length ? "yes" : "no"} />

      {step === 1 ? (
        <>
          <div className="flex flex-col gap-2">
            <h1 ref={headingRef} tabIndex={-1} className="m-0 font-display text-[36px] leading-[0.98] font-extrabold text-navy-950 outline-none">
              Find your garage
            </h1>
            <p className="m-0 text-[15px] leading-6 text-grey-600">
              {placesEnabled ? "Search Google for your garage to fill in your details, or type them in." : "Enter your garage's details. You can change them later."}
            </p>
          </div>

          {placesEnabled ? (
            <section aria-labelledby="places-heading" className="flex flex-col gap-3 rounded-card border border-grey-200 bg-white p-5">
              <h2 id="places-heading" className="m-0 text-[17px] font-bold text-navy-950">Search Google</h2>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="places-query" className="text-[14px] font-semibold text-navy-950">Garage name and town</label>
                <div className="flex gap-2">
                  <input
                    id="places-query"
                    type="search"
                    ref={queryRef}
                    defaultValue=""
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        runSearch();
                      }
                    }}
                    placeholder="e.g. Kingsway Autocare Doncaster"
                    autoComplete="off"
                    className="block min-h-12 w-full min-w-0 rounded-input border border-grey-300 bg-white px-3.5 text-[16px] text-navy-950"
                  />
                  <button type="button" onClick={runSearch} disabled={searching} className={buttonClass("secondary", "md", "min-h-12 shrink-0")}>
                    {searching ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Search size={18} aria-hidden="true" />}
                    Search
                  </button>
                </div>
              </div>
              <div aria-live="polite" className="flex flex-col gap-2">
                {placesMessage ? <p className="m-0 text-[14px] text-grey-700">{placesMessage}</p> : null}
                {results?.length ? (
                  <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Matching garages">
                    {results.map((place) => {
                      const selected = placeId === place.id;
                      return (
                        <li key={place.id}>
                          <button
                            type="button"
                            onClick={() => pick(place)}
                            aria-pressed={selected}
                            className={cn(
                              "flex min-h-14 w-full items-start gap-3 rounded-[12px] border bg-white p-3 text-left",
                              selected ? "border-2 border-accent" : "border-grey-300 hover:border-grey-600",
                            )}
                          >
                            <MapPin size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-text" />
                            <span className="flex min-w-0 flex-col">
                              <span className="font-semibold text-navy-950">{place.name}</span>
                              <span className="text-[13px] text-grey-600">{place.address}</span>
                            </span>
                            {loadingPlace && picked === place.id ? (
                              <LoaderCircle size={18} className="ml-auto shrink-0 animate-spin" aria-label="Loading details" />
                            ) : selected ? (
                              <Check size={18} className="ml-auto shrink-0 text-success-ink" aria-hidden="true" />
                            ) : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                {placeId ? <p className="m-0 text-[14px] font-semibold text-success-ink">Details filled in from Google. Check them below.</p> : null}
              </div>
            </section>
          ) : null}

          <section aria-labelledby="details-heading" className="flex flex-col gap-4 rounded-card border border-grey-200 bg-white p-5">
            <h2 id="details-heading" className="m-0 text-[17px] font-bold text-navy-950">Your details</h2>
            <TextField id="garage-name" name="name" label="Garage name" value={details.name} onChange={set("name")} autoComplete="organization" error={errors.name} />
            <TextField
              id="garage-phone"
              name="phone"
              type="tel"
              label="Phone number"
              hint="Shown on your booking page so customers can call."
              value={details.phone}
              onChange={set("phone")}
              autoComplete="tel"
              inputMode="tel"
              error={errors.phone}
            />
            <TextField id="garage-email" name="email" type="email" label="Email for bookings (optional)" value={details.email} onChange={set("email")} autoComplete="email" inputMode="email" error={errors.email} />
            <TextField id="garage-website" name="website" label="Website (optional)" value={details.website} onChange={set("website")} autoComplete="url" inputMode="url" error={errors.website} />
            <fieldset className="m-0 flex flex-col gap-4 border-0 p-0">
              <legend className="mb-3 p-0 text-[15px] font-bold text-navy-950">Address</legend>
              <TextField id="garage-line1" name="line1" label="Address line 1" value={details.line1} onChange={set("line1")} autoComplete="address-line1" error={errors.line1} />
              <TextField id="garage-line2" name="line2" label="Address line 2 (optional)" value={details.line2} onChange={set("line2")} autoComplete="address-line2" error={errors.line2} />
              <TextField id="garage-town" name="town" label="Town or city" value={details.town} onChange={set("town")} autoComplete="address-level2" error={errors.town} />
              <TextField id="garage-postcode" name="postcode" label="Postcode" value={details.postcode} onChange={set("postcode")} autoComplete="postal-code" autoCapitalize="characters" className="max-w-[200px]" error={errors.postcode} />
            </fieldset>
            {hours.length ? (
              <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-[12px] bg-grey-50 p-3 text-[14px] leading-5">
                <input type="checkbox" checked={useHours} onChange={(event) => setUseHours(event.target.checked)} className="mt-0.5 size-5 shrink-0 accent-[var(--garage-accent)]" />
                <span>
                  <span className="font-semibold text-navy-950">Use my opening hours from Google</span>
                  <span className="block text-grey-600">{describeOpeningHours(hours)}</span>
                </span>
              </label>
            ) : null}
            {errors.openingHours ? <Notice tone="error">{errors.openingHours}</Notice> : null}
          </section>

          <button type="button" onClick={continueToLink} className={buttonClass("primary", "md", "min-h-[54px] w-full text-[16px]")}>
            Continue to your booking link
          </button>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <h1 ref={headingRef} tabIndex={-1} className="m-0 font-display text-[36px] leading-[0.98] font-extrabold text-navy-950 outline-none">
              Choose your booking link
            </h1>
            <p className="m-0 text-[15px] leading-6 text-grey-600">
              Customers book at this address. It&apos;s free; you can connect your own domain later.
            </p>
          </div>

          <section aria-labelledby="link-heading" className="flex flex-col gap-4 rounded-card border border-grey-200 bg-white p-5">
            <h2 id="link-heading" className="m-0 text-[17px] font-bold text-navy-950">{details.name}</h2>
            <TextField
              id="garage-slug"
              name="slug"
              label="Booking link name"
              hint="Lower-case letters, numbers and hyphens."
              value={slug}
              onChange={(event) => changeSlug(event.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={40}
              error={slugError}
            />
            <div aria-live="polite" className="flex flex-col gap-2">
              {checking || checkDue ? <p className="m-0 text-[14px] text-grey-600">Checking…</p> : slugOk ? (
                <p className="m-0 inline-flex items-center gap-1.5 text-[14px] font-semibold text-success-ink">
                  <Check size={16} aria-hidden="true" /> {slugCheck?.message}
                </p>
              ) : null}
              {slugCheck?.alternatives.length && slugCheck.slug === slug ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[14px] text-grey-700">Free:</span>
                  {slugCheck.alternatives.map((alternative) => (
                    <button key={alternative} type="button" onClick={() => changeSlug(alternative, { immediate: true })} className={buttonClass("secondary", "sm")}>
                      {alternative}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="rounded-[12px] bg-grey-50 p-3">
              <p className="m-0 text-[12px] font-semibold tracking-[0.06em] text-grey-600 uppercase">Your booking page</p>
              <p className="m-0 mt-1 font-mono text-[14px] break-all text-navy-950" data-testid="link-preview">{preview}</p>
            </div>
          </section>

          {state.message ? (
            <div data-form-message tabIndex={-1} className="outline-none">
              <Notice tone="error" role="alert">{state.message}</Notice>
            </div>
          ) : null}

          <div className="flex flex-col gap-3">
            <button type="submit" disabled={creating || !slugOk} className={buttonClass("primary", "md", "min-h-[54px] w-full text-[16px]")}>
              {creating ? "Creating your garage…" : "Create my garage"}
            </button>
            <button type="button" onClick={() => setStep(1)} className={buttonClass("ghost", "md", "w-full")}>
              Back to your details
            </button>
          </div>
        </>
      )}
    </form>
  );
}
