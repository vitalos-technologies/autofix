"use client";

import { createContext, useActionState, useContext, useId, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { buttonClass, focusRing, SubmitButton } from "@/components/admin-ui";
import { garageInitials, PlateChip } from "@/components/book";
import { ACCENT_PALETTE, bookingAccent, contrastRatio, garageAccentStyle, MIN_TEXT_CONTRAST, normaliseAccent } from "@/lib/branding/accent";
import { ACCENT_NAMES, initialSetupFormState, type SetupFormState } from "@/lib/settings/setup";
import { cn } from "@/lib/utils";
import { FieldError, FormMessage, inputClass } from "../_components/fields";
import { saveAccentAction, uploadLogoAction } from "./actions";

// Branding page client pieces. The colour picker and the preview share the
// colour being tried, so the preview follows every change before it is saved.

const PreviewContext = createContext<{ accent: string; setAccent: (accent: string) => void } | null>(null);

export function BrandingPreviewProvider({ initialAccent, children }: { initialAccent: string; children: ReactNode }) {
  const [accent, setAccent] = useState(initialAccent);
  return <PreviewContext value={{ accent, setAccent }}>{children}</PreviewContext>;
}

function usePreview() {
  const context = useContext(PreviewContext);
  if (!context) throw new Error("BrandingPreviewProvider is missing");
  return context;
}

/** The four palette colours plus a custom hex colour, with the contrast check and Save. */
export function AccentPicker({ savedAccent, canEdit }: { savedAccent: string; canEdit: boolean }) {
  const { accent, setAccent } = usePreview();
  const [state, formAction] = useActionState<SetupFormState<"accent">, FormData>(saveAccentAction, initialSetupFormState);
  const inPalette = (ACCENT_PALETTE as readonly string[]).includes(savedAccent);
  const [customOpen, setCustomOpen] = useState(!inPalette);
  const [customText, setCustomText] = useState(inPalette ? "" : savedAccent);
  const ids = useId();
  const customId = `${ids}-custom`;
  const checkId = `${ids}-check`;

  const requested = normaliseAccent(accent);
  const effective = bookingAccent(requested);
  const ratio = requested ? contrastRatio(requested, "#ffffff") : 0;
  const effectiveRatio = contrastRatio(effective, "#ffffff");
  const adjusted = Boolean(requested && effective !== requested);
  const customInvalid = customOpen && customText.trim() !== "" && !normaliseAccent(customText);

  return (
    <form action={formAction} noValidate className="flex flex-col gap-4">
      <input type="hidden" name="accent" value={requested ?? ""} />
      <fieldset disabled={!canEdit} className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
        <legend className="sr-only">Brand colour</legend>
        <div className="flex flex-wrap gap-2.5">
          {ACCENT_PALETTE.map((colour) => {
            const pressed = requested === colour;
            return (
              <button
                key={colour}
                type="button"
                aria-label={ACCENT_NAMES[colour] ?? colour}
                aria-pressed={pressed}
                onClick={() => {
                  setAccent(colour);
                  setCustomOpen(false);
                }}
                style={{ background: colour }}
                className={cn(
                  "flex size-11 items-center justify-center rounded-full text-white disabled:cursor-not-allowed",
                  pressed ? "border-[3px] border-white outline-2 outline-offset-0 outline-navy-950 outline-solid" : "border-0",
                  focusRing,
                )}
              >
                {pressed ? <Check size={18} strokeWidth={3} aria-hidden="true" /> : null}
              </button>
            );
          })}
          <button
            type="button"
            aria-expanded={customOpen}
            aria-controls={customId}
            onClick={() => {
              setCustomOpen(true);
              if (customText && normaliseAccent(customText)) setAccent(normaliseAccent(customText)!);
            }}
            className={cn(
              "flex min-h-11 items-center gap-2 rounded-full border border-dashed border-grey-600 bg-white px-4 text-[14px] font-semibold text-grey-700 disabled:cursor-not-allowed",
              customOpen && "border-solid border-navy-950 text-navy-950",
              focusRing,
            )}
          >
            Custom colour
          </button>
        </div>

        <div id={customId} hidden={!customOpen} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[14px] font-semibold text-grey-800">Pick</span>
            <input
              type="color"
              value={requested ?? "#155fba"}
              onChange={(event) => {
                setCustomText(event.target.value);
                setAccent(event.target.value);
              }}
              className="h-11 w-16 cursor-pointer rounded-input border border-grey-300 bg-white p-1"
            />
          </label>
          <label className="flex min-w-0 flex-[0_1_200px] flex-col gap-1.5">
            <span className="text-[14px] font-semibold text-grey-800">Hex code</span>
            <input
              value={customText}
              placeholder="#155fba"
              maxLength={7}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={customInvalid || undefined}
              aria-describedby={customInvalid ? `${customId}-error` : undefined}
              onChange={(event) => {
                setCustomText(event.target.value);
                const value = normaliseAccent(event.target.value);
                if (value) setAccent(value);
              }}
              className={cn(inputClass, "font-mono", customInvalid ? "border-2 border-[#b91c1c]" : "border-grey-300")}
            />
          </label>
          <FieldError id={customId} error={customInvalid ? "Enter six hex digits, for example #155fba." : state.fieldErrors?.accent} />
        </div>
      </fieldset>

      <div id={checkId} role="status" className={cn("flex flex-col gap-2 rounded-input px-3.5 py-3 text-[14px] leading-snug", adjusted ? "bg-warning-bg text-warning-ink" : "bg-grey-50 text-grey-700")}>
        {requested ? (
          adjusted ? (
            <>
              <p className="m-0 font-semibold">White text on {requested} is {ratio.toFixed(1)}:1, below the {MIN_TEXT_CONTRAST}:1 needed to read it easily.</p>
              <p className="m-0 flex flex-wrap items-center gap-2">
                <Swatch colour={requested} /> <span aria-hidden="true">becomes</span> <Swatch colour={effective} />
                <span>
                  We&apos;ll save it as {effective} ({effectiveRatio.toFixed(1)}:1), the closest readable shade.
                </span>
              </p>
            </>
          ) : (
            <p className="m-0">
              White text on {requested} is {ratio.toFixed(1)}:1. Easy to read: it will be used as it is.
            </p>
          )
        ) : (
          <p className="m-0">Enter a colour to check it.</p>
        )}
      </div>

      <FormMessage state={state} />
      {canEdit ? (
        <SubmitButton className={buttonClass("primary", "md", "w-full sm:w-fit")} aria-disabled={!requested || undefined}>
          Save colour
        </SubmitButton>
      ) : null}
    </form>
  );
}

function Swatch({ colour }: { colour: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[13px]">
      <span aria-hidden="true" style={{ background: colour }} className="inline-block size-5 rounded-full border border-grey-300" />
      {colour}
    </span>
  );
}

/** Booking header, plate and primary button in the colour being tried (as Admin-Domain's branding card). */
export function BrandingPreview({ garageName, logoUrl }: { garageName: string; logoUrl: string | null }) {
  const { accent } = usePreview();
  const initials = garageInitials(garageName);
  return (
    <div
      style={garageAccentStyle(accent)}
      role="img"
      aria-label={`Preview of ${garageName}'s booking page in ${bookingAccent(accent)}`}
      className="flex flex-col overflow-hidden rounded-hero border border-grey-200"
    >
      <div className="flex items-center gap-2.5 bg-navy-950 px-3 py-2.5">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- the garage's own uploaded file, shown as is
          <img src={logoUrl} alt="" className="size-7 rounded-[8px] bg-white object-contain" />
        ) : (
          <span className="flex size-7 items-center justify-center rounded-[8px] bg-accent font-display text-[13px] font-extrabold text-accent-ink">{initials}</span>
        )}
        <span className="truncate text-[13px] font-bold text-white">{garageName}</span>
      </div>
      <div className="flex flex-col gap-2.5 bg-grey-50 px-3 py-3.5">
        <span className="font-sans text-[12px] font-semibold text-grey-600">Step 1 of 5</span>
        <span className="font-display text-[22px] leading-none font-extrabold text-navy-950">What are we booking in?</span>
        <div className="flex h-10 items-center justify-center rounded-[7px] border-2 border-[#111827] bg-plate">
          <PlateChip registration="AB12CDE" className="bg-transparent text-[20px] tracking-[0.08em]" />
        </div>
        <span className="text-[13px] font-semibold text-accent-text underline underline-offset-2">Enter details manually</span>
        <div className="flex h-[42px] items-center justify-center rounded-[12px] bg-accent text-[14px] font-bold text-accent-ink">Continue</div>
      </div>
    </div>
  );
}

/** Logo upload: PNG, JPEG or WebP up to 1.5 MB. */
export function LogoForm({ canEdit, hasLogo }: { canEdit: boolean; hasLogo: boolean }) {
  const [state, formAction] = useActionState<SetupFormState<"logo">, FormData>(uploadLogoAction, initialSetupFormState);
  const error = state.fieldErrors?.logo;
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="logo-file" className="text-[14px] font-semibold text-grey-800">
          {hasLogo ? "Replace logo" : "Upload a logo"}
        </label>
        <input
          id="logo-file"
          name="logo"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          required
          disabled={!canEdit}
          aria-invalid={error ? true : undefined}
          aria-describedby={["logo-file-hint", error ? "logo-file-error" : null].filter(Boolean).join(" ")}
          className={cn(
            "min-h-11 w-full min-w-0 rounded-input border bg-white px-2 py-1.5 text-[14px] text-grey-800",
            "file:mr-3 file:min-h-9 file:cursor-pointer file:rounded-[10px] file:border file:border-solid file:border-grey-300 file:bg-white file:px-3 file:font-semibold file:text-navy-950",
            "focus-visible:border-2 focus-visible:border-accent focus-visible:outline-none",
            error ? "border-2 border-[#b91c1c]" : "border-grey-300",
          )}
        />
        <p id="logo-file-hint" className="m-0 text-[13px] text-grey-600">
          PNG, JPEG or WebP, up to 1.5 MB. A square logo on a plain background works best.
        </p>
        <FieldError id="logo-file" error={error} />
      </div>
      <FormMessage state={state} />
      {canEdit ? <SubmitButton className={buttonClass("secondary", "md", "w-full sm:w-fit")}>Upload logo</SubmitButton> : null}
    </form>
  );
}
