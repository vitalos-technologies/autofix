"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { buttonClass, Panel, SubmitButton } from "@/components/admin-ui";
import { formatDuration, formatServicePrice } from "@/components/book";
import {
  initialSetupFormState,
  parsePounds,
  penceToPoundsInput,
  SERVICE_LIMITS,
  type PriceModeValue,
  type ServiceField,
  type ServiceLocationValue,
  type SetupFormState,
  type WorkshopResourceKind,
} from "@/lib/settings/setup";
import { CheckboxField, ChoiceGroup, FormMessage, SelectField, TextAreaField, TextInputField } from "../_components/fields";
import { saveServiceAction } from "./actions";

export type ServiceFormValues = {
  id: string | null;
  name: string;
  description: string;
  priceMode: PriceModeValue;
  pricePence: number | null;
  durationMin: number;
  bufferMin: number;
  locationMode: ServiceLocationValue;
  resourceKind: "bay" | "mobile" | "technician";
  onlineEnabled: boolean;
  needsApproval: boolean;
  minNoticeH: number;
  maxDaysAhead: number;
  isMot: boolean;
};

const PRICE_OPTIONS = [
  { value: "fixed", label: "Fixed price" },
  { value: "from", label: "From a price" },
  { value: "quote", label: "Quote" },
] as const;

const LOCATION_OPTIONS = [
  { value: "workshop", label: "Workshop" },
  { value: "mobile", label: "Mobile visit" },
  { value: "both", label: "Either" },
] as const;

const FIELD_ORDER: ServiceField[] = ["name", "description", "priceMode", "price", "durationMin", "bufferMin", "locationMode", "resourceKind", "minNoticeH", "maxDaysAhead"];

/** Add or edit a service. Every field is checked again by the server action. */
export function ServiceForm({ initial, motEnabled, garageName }: { initial: ServiceFormValues; motEnabled: boolean; garageName: string }) {
  const [state, formAction] = useActionState<SetupFormState<ServiceField>, FormData>(saveServiceAction, initialSetupFormState);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [priceMode, setPriceMode] = useState<PriceModeValue>(initial.priceMode);
  const [price, setPrice] = useState(penceToPoundsInput(initial.pricePence));
  const [durationMin, setDurationMin] = useState(String(initial.durationMin));
  const [bufferMin, setBufferMin] = useState(String(initial.bufferMin));
  const [locationMode, setLocationMode] = useState<ServiceLocationValue>(initial.locationMode);
  const [resourceKind, setResourceKind] = useState<WorkshopResourceKind>(initial.resourceKind === "technician" ? "technician" : "bay");
  const [onlineEnabled, setOnlineEnabled] = useState(initial.onlineEnabled);
  const [needsApproval, setNeedsApproval] = useState(initial.needsApproval);
  const [minNoticeH, setMinNoticeH] = useState(String(initial.minNoticeH));
  const [maxDaysAhead, setMaxDaysAhead] = useState(String(initial.maxDaysAhead));
  const [isMot, setIsMot] = useState(initial.isMot);
  const handled = useRef(state.seq);
  const errors = state.fieldErrors ?? {};

  useEffect(() => {
    if (state.seq === handled.current) return;
    handled.current = state.seq;
    const first = FIELD_ORDER.find((field) => state.fieldErrors?.[field]);
    if (first) document.getElementById(`service-${first}`)?.focus();
    else if (state.status === "error") document.getElementById("service-form-message")?.focus();
  }, [state]);

  const previewPence = priceMode === "quote" ? null : parsePounds(price);
  const previewDuration = Number.parseInt(durationMin, 10);

  return (
    <form action={formAction} noValidate className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      {initial.id ? <input type="hidden" name="serviceId" value={initial.id} /> : null}
      <div className="flex min-w-0 flex-col gap-5">
        <div id="service-form-message" tabIndex={-1} className="outline-none">
          <FormMessage state={state} />
        </div>

        <Panel title="What customers see">
          <TextInputField
            id="service-name"
            name="name"
            label="Name"
            required
            maxLength={SERVICE_LIMITS.name}
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
            error={errors.name}
          />
          <TextAreaField
            id="service-description"
            name="description"
            label="Description"
            hint="One or two lines under the name on the booking page."
            maxLength={SERVICE_LIMITS.description}
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            error={errors.description}
          />
          <ChoiceGroup
            id="service-priceMode"
            name="priceMode"
            legend="Price"
            options={PRICE_OPTIONS}
            value={priceMode}
            onChange={setPriceMode}
            error={errors.priceMode}
            hint={priceMode === "quote" ? "Customers see Quote. You price the job after a look at the car." : priceMode === "from" ? "Customers see From and the price." : "Customers see the price."}
          />
          {priceMode !== "quote" ? (
            <TextInputField
              id="service-price"
              name="price"
              label={priceMode === "from" ? "Starting price" : "Price"}
              prefix="£"
              inputMode="decimal"
              autoComplete="off"
              placeholder="54.85"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              error={errors.price}
              fieldClassName="max-w-[260px]"
            />
          ) : null}
        </Panel>

        <Panel title="Time and place">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextInputField
              id="service-durationMin"
              name="durationMin"
              label="How long it takes"
              suffix="minutes"
              inputMode="numeric"
              value={durationMin}
              onChange={(event) => setDurationMin(event.target.value)}
              error={errors.durationMin}
              hint="Customers see this as the appointment length."
            />
            <TextInputField
              id="service-bufferMin"
              name="bufferMin"
              label="Clean-up time after"
              suffix="minutes"
              inputMode="numeric"
              value={bufferMin}
              onChange={(event) => setBufferMin(event.target.value)}
              error={errors.bufferMin}
              hint="Keeps the bay free afterwards. Not shown to customers."
            />
          </div>
          <ChoiceGroup
            id="service-locationMode"
            name="locationMode"
            legend="Where the work is done"
            options={LOCATION_OPTIONS}
            value={locationMode}
            onChange={setLocationMode}
            error={errors.locationMode}
            hint={locationMode === "workshop" ? "At your garage." : locationMode === "mobile" ? "At the customer's address, using your mobile van." : "Customers choose the workshop or a mobile visit."}
          />
          {locationMode !== "mobile" ? (
            <SelectField
              id="service-resourceKind"
              name="resourceKind"
              label="In the workshop it takes"
              value={resourceKind}
              onChange={(event) => setResourceKind(event.target.value as WorkshopResourceKind)}
              error={errors.resourceKind}
              hint="Mobile visits always take a mobile van."
              fieldClassName="max-w-[320px]"
            >
              <option value="bay">A bay</option>
              <option value="technician">A technician</option>
            </SelectField>
          ) : null}
        </Panel>

        <Panel title="Online booking">
          <CheckboxField
            id="service-onlineEnabled"
            name="onlineEnabled"
            label="Customers can book this online"
            hint="Untick to keep it for bookings you make yourself."
            checked={onlineEnabled}
            onChange={(event) => setOnlineEnabled(event.target.checked)}
          />
          <CheckboxField
            id="service-needsApproval"
            name="needsApproval"
            label="You confirm each booking first"
            hint="Online bookings wait in Needs your OK until you accept them."
            checked={needsApproval}
            onChange={(event) => setNeedsApproval(event.target.checked)}
          />
          {motEnabled ? (
            <CheckboxField
              id="service-isMot"
              name="isMot"
              label="This is an MOT test"
              hint="MOT services are shown only while MOT is switched on."
              checked={isMot}
              onChange={(event) => setIsMot(event.target.checked)}
            />
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <TextInputField
              id="service-minNoticeH"
              name="minNoticeH"
              label="Notice needed"
              suffix="hours"
              inputMode="numeric"
              value={minNoticeH}
              onChange={(event) => setMinNoticeH(event.target.value)}
              error={errors.minNoticeH}
              hint="The earliest a customer can book, from now."
            />
            <TextInputField
              id="service-maxDaysAhead"
              name="maxDaysAhead"
              label="Bookable up to"
              suffix="days ahead"
              inputMode="numeric"
              value={maxDaysAhead}
              onChange={(event) => setMaxDaysAhead(event.target.value)}
              error={errors.maxDaysAhead}
            />
          </div>
        </Panel>

        <div className="flex flex-wrap items-center gap-2.5">
          <SubmitButton className={buttonClass("primary", "md", "min-w-[160px]")}>{initial.id ? "Save service" : "Add service"}</SubmitButton>
          <Link href="/app/settings/services" className={buttonClass("secondary")}>
            Cancel
          </Link>
        </div>
      </div>

      <aside aria-labelledby="service-preview-title" className="lg:sticky lg:top-6">
        <Panel>
          <h2 id="service-preview-title" className="m-0 font-sans text-[17px] font-bold tracking-normal text-navy-950">
            On the booking page
          </h2>
          <p className="m-0 text-[13px] text-grey-600">How {garageName} customers see it on the service step.</p>
          <div className="flex items-center gap-3 rounded-control border-2 border-accent bg-white px-[14px] py-3" aria-hidden="true">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-accent">
              <span className="size-2.5 rounded-full bg-accent" />
            </span>
            <span className="flex min-w-0 grow flex-col gap-0.5">
              <span className="text-[15px] font-bold break-words text-navy-950">{name.trim() || "Service name"}</span>
              <span className="text-[12.5px] break-words text-grey-600">
                {[description.trim(), Number.isFinite(previewDuration) ? formatDuration(previewDuration) : ""].filter(Boolean).join(" · ") || "Description"}
              </span>
            </span>
            <span className="shrink-0 text-right text-[13px] font-semibold text-grey-700">{formatServicePrice(previewPence, priceMode)}</span>
          </div>
          <p className="m-0 text-[13px] text-grey-600">
            {onlineEnabled ? "Bookable online." : "Not shown to customers: staff bookings only."}
            {needsApproval ? " Each booking waits for your OK." : ""}
          </p>
        </Panel>
      </aside>
    </form>
  );
}
