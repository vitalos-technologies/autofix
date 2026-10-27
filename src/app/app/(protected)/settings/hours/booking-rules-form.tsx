"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Badge, buttonClass, Panel, SubmitButton } from "@/components/admin-ui";
import {
  initialSetupFormState,
  parseServiceArea,
  SLOT_STEP_OPTIONS,
  type BookingRulesField,
  type SetupFormState,
} from "@/lib/settings/setup";
import { CheckboxField, FormMessage, SelectField, TextAreaField, TextInputField } from "../_components/fields";
import { ReadOnlyNotice, SetupNotice } from "../_components/setup-nav";
import { saveBookingRulesAction } from "./actions";

export type BookingRulesValues = {
  slotStepMin: number;
  approveOnline: boolean;
  cancellationCutoffH: number;
  mobileTravelMin: number;
  serviceArea: string[];
};

const FIELD_ORDER: BookingRulesField[] = ["slotStepMin", "cancellationCutoffH", "mobileTravelMin", "serviceArea"];

function stepLabel(minutes: number) {
  if (minutes < 60) return `Every ${minutes} minutes`;
  if (minutes === 60) return "Every hour";
  return `Every ${minutes / 60} hours`.replace("1.5 hours", "1½ hours");
}

/** Garage-wide booking rules (owners only; everyone else sees them read only). */
export function BookingRulesForm({ initial, canEdit, offersMobile }: { initial: BookingRulesValues; canEdit: boolean; offersMobile: boolean }) {
  const [state, formAction] = useActionState<SetupFormState<BookingRulesField>, FormData>(saveBookingRulesAction, initialSetupFormState);
  const [slotStepMin, setSlotStepMin] = useState(String(initial.slotStepMin));
  const [approveOnline, setApproveOnline] = useState(initial.approveOnline);
  const [cutoff, setCutoff] = useState(String(initial.cancellationCutoffH));
  const [travel, setTravel] = useState(String(initial.mobileTravelMin));
  const [area, setArea] = useState(initial.serviceArea.join(", "));
  const handled = useRef(state.seq);
  const districts = parseServiceArea(area).districts;
  const stepOptions = SLOT_STEP_OPTIONS.includes(initial.slotStepMin as (typeof SLOT_STEP_OPTIONS)[number])
    ? SLOT_STEP_OPTIONS
    : [...SLOT_STEP_OPTIONS, initial.slotStepMin].sort((left, right) => left - right);

  useEffect(() => {
    if (state.seq === handled.current) return;
    handled.current = state.seq;
    const first = FIELD_ORDER.find((field) => state.fieldErrors?.[field]);
    if (first) document.getElementById(`rules-${first}`)?.focus();
  }, [state]);

  return (
    <Panel id="booking-rules" title="Booking rules">
      {!canEdit ? <ReadOnlyNotice level="owner" /> : null}
      <form action={formAction} noValidate className="flex flex-col gap-4">
        <fieldset disabled={!canEdit} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
          <legend className="sr-only">Booking rules</legend>
          <div className="grid gap-4 md:grid-cols-2">
            <SelectField
              id="rules-slotStepMin"
              name="slotStepMin"
              label="Start times offered"
              value={slotStepMin}
              onChange={(event) => setSlotStepMin(event.target.value)}
              error={state.fieldErrors?.slotStepMin}
              hint="From each opening time, for example 8:00, 8:15, 8:30."
              fieldClassName="md:max-w-[360px]"
            >
              {stepOptions.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {stepLabel(minutes)}
                </option>
              ))}
            </SelectField>
            <TextInputField
              id="rules-cancellationCutoffH"
              name="cancellationCutoffH"
              label="Customers can change or cancel online until"
              suffix="hours before"
              inputMode="numeric"
              value={cutoff}
              onChange={(event) => setCutoff(event.target.value)}
              error={state.fieldErrors?.cancellationCutoffH}
              hint="After that they call you. 0 allows changes up to the start."
            />
          </div>
          <CheckboxField
            id="rules-approveOnline"
            name="approveOnline"
            label="Approve every online booking yourself"
            hint="Online bookings wait in Needs your OK until you accept them. Customers are told the garage will confirm."
            checked={approveOnline}
            onChange={(event) => setApproveOnline(event.target.checked)}
          />
          <div className="flex flex-col gap-4 border-t border-[#eef2f6] pt-4">
            <h3 className="m-0 font-sans text-[15px] font-bold tracking-normal text-navy-950">Mobile visits</h3>
            <TextInputField
              id="rules-mobileTravelMin"
              name="mobileTravelMin"
              label="Travel time"
              suffix="minutes each way"
              inputMode="numeric"
              value={travel}
              onChange={(event) => setTravel(event.target.value)}
              error={state.fieldErrors?.mobileTravelMin}
              hint="Kept free on the van before and after each visit."
              fieldClassName="max-w-[360px]"
            />
            <TextAreaField
              id="rules-serviceArea"
              name="serviceArea"
              label="Postcode districts you cover"
              rows={2}
              placeholder="DN1, DN2, DN4"
              value={area}
              onChange={(event) => setArea(event.target.value)}
              error={state.fieldErrors?.serviceArea}
              hint="The first half of a postcode, separated by commas or spaces. Mobile visits are offered only in these districts."
            />
            {districts.length ? (
              <ul aria-label="Districts covered" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
                {districts.map((district) => (
                  <li key={district}>
                    <Badge tone="neutral" size="md">
                      {district}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : offersMobile ? (
              <SetupNotice tone="warning">No districts yet, so customers can&apos;t book a mobile visit.</SetupNotice>
            ) : null}
          </div>
        </fieldset>
        <FormMessage state={state} />
        {canEdit ? <SubmitButton className={buttonClass("primary", "md", "w-full sm:w-fit")}>Save booking rules</SubmitButton> : null}
      </form>
    </Panel>
  );
}
