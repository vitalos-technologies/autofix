"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { LoaderCircle, Search, Shield, UserRound } from "lucide-react";
import { PlateInput, StickyActionBar, VehicleCard, compactRegistration, formatRegistrationDisplay } from "@/components/book";
import { focusRing } from "@/components/book/styles";
import { TurnstileField } from "@/components/forms/turnstile-field";
import { vehicleStepAction } from "@/lib/booking-flow/actions";
import { initialVehicleFormState, type VehicleFormState } from "@/lib/booking-flow/forms";
import type { DraftVehicle } from "@/lib/booking-flow/vehicle";
import { cn } from "@/lib/utils";
import { FormAlert } from "./booking-screen";
import { TextField } from "./text-field";

const FORM_ID = "vehicle-form";

const linkButton = cn(
  "inline-flex min-h-11 items-center rounded-[6px] bg-transparent p-0 text-left text-[14px] font-semibold text-accent underline underline-offset-2 hover:text-blue-700",
  focusRing,
);

type VehicleStepProps = {
  motEnabled: boolean;
  timeZone: string;
  /** The car already in the booking draft, if any. */
  initialVehicle: DraftVehicle | null;
  /** Show Turnstile (configured and not yet passed for this booking). */
  humanCheck: boolean;
};

/** Step 1: registration, Find my car, the car found (or manual make and model), Continue. */
export function VehicleStep({ motEnabled, timeZone, initialVehicle, humanCheck }: VehicleStepProps) {
  const looked = initialVehicle && !initialVehicle.manual ? initialVehicle : null;
  const [state, formAction, pending] = useActionState<VehicleFormState, FormData>(vehicleStepAction, {
    ...initialVehicleFormState,
    status: looked ? "found" : "idle",
    vehicle: looked,
  });
  const [plate, setPlate] = useState(initialVehicle ? formatRegistrationDisplay(initialVehicle.registration) : "");
  const [manual, setManual] = useState(Boolean(initialVehicle?.manual));
  const [make, setMake] = useState(initialVehicle?.manual ? (initialVehicle.make ?? "") : "");
  const [model, setModel] = useState(initialVehicle?.manual ? (initialVehicle.model ?? "") : "");
  const [token, setToken] = useState("");
  const [intent, setIntent] = useState<"find" | "reset" | "continue">("continue");
  const formRef = useRef<HTMLFormElement>(null);
  const findRef = useRef<HTMLButtonElement>(null);
  const makeRef = useRef<HTMLInputElement>(null);
  const handledSeq = useRef(state.seq);

  const found = state.vehicle && compactRegistration(plate) === state.vehicle.registration ? state.vehicle : null;
  const wasReset = state.seq > 0 && state.status === "idle";

  // After each response, move focus to where the customer needs to look next.
  useEffect(() => {
    if (state.seq === handledSeq.current) return;
    handledSeq.current = state.seq;
    if (wasReset) {
      document.getElementById("registration")?.focus();
      return;
    }
    if (state.fieldErrors?.registration) document.getElementById("registration")?.focus();
    else if (state.fieldErrors?.make) makeRef.current?.focus();
    else if (state.fieldErrors?.model) document.getElementById("vehicle-model")?.focus();
  }, [state, wasReset]);

  function openManual() {
    setManual(true);
    requestAnimationFrame(() => makeRef.current?.focus());
  }

  const finding = pending && intent === "find";

  return (
    <>
      <form
        ref={formRef}
        id={FORM_ID}
        action={formAction}
        onSubmit={(event) => {
          const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
          const next = submitter?.value === "find" ? "find" : submitter?.value === "reset" ? "reset" : "continue";
          setIntent(next);
          // "Not your car?" forgets the car: the plate is cleared for a fresh registration.
          if (next === "reset") setPlate("");
        }}
        noValidate
        className="flex flex-col gap-[18px] px-5 pt-[22px]"
      >
        <div className="flex flex-col gap-2">
          <h1 className="m-0 font-display text-[38px] leading-[0.98] font-extrabold tracking-[-0.01em] text-navy-950">What are we booking in?</h1>
          <p className="m-0 text-[15px] leading-normal text-grey-600">
            Enter your registration and we&apos;ll find the car. Takes about a minute, no account needed.
          </p>
        </div>

        <input type="hidden" name="mode" value={manual ? "manual" : "lookup"} />
        <div className="flex flex-col gap-2">
          <PlateInput
            id="registration"
            name="registration"
            value={plate}
            onChange={setPlate}
            error={state.fieldErrors?.registration}
            onEnter={() => {
              if (manual) formRef.current?.requestSubmit();
              else formRef.current?.requestSubmit(findRef.current);
            }}
          />
          {manual ? null : (
            <button
              ref={findRef}
              type="submit"
              name="intent"
              value="find"
              disabled={pending}
              className={cn(
                "flex h-12 items-center justify-center gap-2 rounded-control border-[1.5px] border-navy-950 bg-white text-[15px] font-bold text-navy-950 transition-colors hover:bg-grey-100 disabled:cursor-wait",
                focusRing,
              )}
            >
              {finding ? (
                <LoaderCircle size={18} strokeWidth={2} aria-hidden="true" className="animate-spin" />
              ) : (
                <Search size={18} strokeWidth={2.2} aria-hidden="true" />
              )}
              {finding ? "Finding your car" : "Find my car"}
            </button>
          )}
        </div>

        {humanCheck ? (
          <div>
            <TurnstileField onToken={setToken} />
            <input type="hidden" name="turnstileToken" value={token} />
          </div>
        ) : null}

        <div aria-live="polite" className="contents">
          {found && !manual ? (
            <VehicleCard
              make={found.make ?? ""}
              model={found.model}
              year={found.year}
              engine={found.engine}
              colour={found.colour}
              motEnabled={motEnabled}
              motExpiry={found.motExpiry}
              lastMileage={found.lastMileage}
              timeZone={timeZone}
              selected
            />
          ) : null}
        </div>

        {manual ? (
          <fieldset className="m-0 flex flex-col gap-3.5 border-0 p-0">
            <legend className="mb-1 p-0 text-[15px] font-bold text-navy-950">Your car&apos;s details</legend>
            <TextField
              ref={makeRef}
              id="vehicle-make"
              name="make"
              label="Make"
              autoComplete="off"
              placeholder="For example Ford"
              value={make}
              onChange={(event) => setMake(event.target.value)}
              error={state.fieldErrors?.make}
              maxLength={80}
            />
            <TextField
              id="vehicle-model"
              name="model"
              label="Model"
              autoComplete="off"
              placeholder="For example Focus"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              error={state.fieldErrors?.model}
              maxLength={120}
            />
          </fieldset>
        ) : null}

        {state.message ? <FormAlert>{state.message}</FormAlert> : null}
        {wasReset ? (
          <p role="status" className="m-0 text-[13.5px] leading-[1.45] text-grey-700">
            Check the registration and find the car again, or enter its details yourself.
          </p>
        ) : null}

        {/* 44px targets; the negative margin keeps the text where the design puts it. */}
        <div className="-my-3 flex flex-wrap items-center justify-between gap-x-4">
          {found && !manual ? (
            <button type="submit" name="intent" value="reset" formNoValidate disabled={pending} className={linkButton}>
              Not your car?
            </button>
          ) : null}
          {manual ? (
            <button type="button" onClick={() => setManual(false)} className={linkButton}>
              Look up the registration instead
            </button>
          ) : (
            <button type="button" onClick={openManual} className={linkButton}>
              Enter details manually
            </button>
          )}
        </div>

        <ul className="m-0 flex list-none flex-col gap-2.5 p-0 pt-1">
          <li className="flex items-center gap-2.5 text-[13px] text-grey-700">
            <UserRound size={18} strokeWidth={2} aria-hidden="true" className="shrink-0 text-grey-600" />
            Book as a guest, no account or password
          </li>
          <li className="flex items-center gap-2.5 text-[13px] text-grey-700">
            <Shield size={18} strokeWidth={2} aria-hidden="true" className="shrink-0 text-grey-600" />
            Your registration never appears in links or analytics
          </li>
        </ul>
      </form>
      <StickyActionBar
        type="submit"
        form={FORM_ID}
        label="Continue"
        busy={pending && intent === "continue"}
        disabled={pending}
        footnote={<span className="text-[11px] text-[#6a7686]">Powered by Pitline</span>}
      />
    </>
  );
}
