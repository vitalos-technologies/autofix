"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { SegmentedControl, ServiceOption, StickyActionBar, SymptomChips } from "@/components/book";
import type { LocationMode, OnlineService } from "@/lib/booking-engine/types";
import { serviceStepAction } from "@/lib/booking-flow/actions";
import { NOTE_MAX_LENGTH, SYMPTOM_OPTIONS } from "@/lib/booking-flow/copy";
import { initialServiceFormState, type ServiceFormState } from "@/lib/booking-flow/forms";
import { serviceLocationModes } from "@/lib/booking-flow/steps";
import { FormAlert } from "./booking-screen";
import { TextField } from "./text-field";

const FORM_ID = "service-form";

const MODE_OPTIONS = [
  { value: "workshop", label: "At the workshop" },
  { value: "mobile", label: "Mobile visit" },
] as const satisfies ReadonlyArray<{ value: LocationMode; label: string }>;

/** What the step needs from a service (client-safe subset of `OnlineService`). */
export type ServiceChoice = Pick<OnlineService, "id" | "name" | "description" | "durationMin" | "pricePence" | "priceMode" | "locationMode">;

type ServiceStepProps = {
  services: readonly ServiceChoice[];
  /** The garage's "Show prices on my booking page" (default on). */
  showPrices?: boolean;
  initial: {
    serviceId?: string;
    locationMode?: LocationMode;
    postcode?: string;
    symptoms?: string[];
    note?: string;
  };
};

/** Step 2: the service (radio cards), workshop or mobile, symptoms and a note. */
export function ServiceStep({ services, showPrices = true, initial }: ServiceStepProps) {
  const [state, formAction, pending] = useActionState<ServiceFormState, FormData>(serviceStepAction, initialServiceFormState);
  const [serviceId, setServiceId] = useState<string | null>(
    initial.serviceId && services.some((service) => service.id === initial.serviceId) ? initial.serviceId : null,
  );
  const [mode, setMode] = useState<LocationMode>(initial.locationMode ?? "workshop");
  const [postcode, setPostcode] = useState(initial.postcode ?? "");
  const [symptoms, setSymptoms] = useState<string[]>(initial.symptoms ?? []);
  const [note, setNote] = useState(initial.note ?? "");
  const handledSeq = useRef(state.seq);

  const service = services.find((item) => item.id === serviceId) ?? null;
  const modes = service ? serviceLocationModes(service) : [];
  const locationMode: LocationMode = modes.includes(mode) ? mode : (modes[0] ?? "workshop");

  useEffect(() => {
    if (state.seq === handledSeq.current) return;
    handledSeq.current = state.seq;
    if (state.fieldErrors?.serviceId) document.querySelector<HTMLInputElement>(`#${FORM_ID} input[name="serviceId"]`)?.focus();
    else if (state.fieldErrors?.postcode) document.getElementById("visit-postcode")?.focus();
  }, [state]);

  return (
    <>
      <form id={FORM_ID} action={formAction} noValidate className="flex flex-col gap-4 px-5 pt-5">
        <h1 className="m-0 font-display text-[36px] leading-[0.98] font-extrabold text-navy-950">What does it need?</h1>

        <fieldset
          aria-describedby={state.fieldErrors?.serviceId ? "service-error" : undefined}
          className="m-0 flex flex-col gap-2 border-0 p-0"
        >
          <legend className="sr-only">Choose a service</legend>
          {state.fieldErrors?.serviceId ? (
            <p id="service-error" className="m-0 text-[13px] font-semibold text-[#b91c1c]">
              {state.fieldErrors.serviceId}
            </p>
          ) : null}
          {services.map((item) => (
            <ServiceOption
              key={item.id}
              name="serviceId"
              value={item.id}
              label={item.name}
              description={item.description}
              // Quoted jobs are inspected first, so their length is not promised.
              durationMinutes={item.priceMode === "quote" ? null : item.durationMin}
              pricePence={item.pricePence}
              priceMode={item.priceMode}
              showPrice={showPrices}
              checked={serviceId === item.id}
              onSelect={setServiceId}
            />
          ))}
        </fieldset>

        {service && modes.length > 1 ? (
          <SegmentedControl label="Where?" options={MODE_OPTIONS} value={locationMode} onChange={setMode} />
        ) : null}
        <input type="hidden" name="locationMode" value={locationMode} />

        {service && locationMode === "mobile" ? (
          <TextField
            id="visit-postcode"
            name="postcode"
            label="Postcode for the visit"
            hint="Where the car will be when we come to you."
            autoComplete="postal-code"
            autoCapitalize="characters"
            maxLength={10}
            value={postcode}
            onChange={(event) => setPostcode(event.target.value)}
            error={state.fieldErrors?.postcode}
          />
        ) : null}

        <SymptomChips
          options={SYMPTOM_OPTIONS}
          selected={symptoms}
          onChange={setSymptoms}
          note={note}
          onNoteChange={setNote}
          noteMaxLength={NOTE_MAX_LENGTH}
        />
        {symptoms.map((symptom) => (
          <input key={symptom} type="hidden" name="symptom" value={symptom} />
        ))}
        <input type="hidden" name="note" value={note} />

        {state.message ? <FormAlert>{state.message}</FormAlert> : null}
      </form>
      <StickyActionBar type="submit" form={FORM_ID} label="Choose a time" busy={pending} />
    </>
  );
}
