"use client";

import { useState, type ReactNode } from "react";
import { Check, Clock, Search, Shield, User } from "lucide-react";
import {
  BookingSummaryBar,
  ConfirmationCard,
  ConsentCheckbox,
  DateStrip,
  GarageHeader,
  PlateChip,
  PlateInput,
  SegmentedControl,
  ServiceOption,
  SlotGrid,
  StepProgress,
  StickyActionBar,
  SymptomChips,
  VehicleCard,
  formatPlateInput,
  formatSlotLabel,
  formatTime,
  stickyActionBarPadding,
  type DateStripDay,
  type PriceMode,
  type TimeSlot,
} from "@/components/book";
import { ACCENT_PALETTE, garageAccentStyle } from "@/lib/branding/accent";
import { cn } from "@/lib/utils";

/* Sample data for the gallery only. Components never hard-code any of this. */
const GARAGE = { name: "Hartley Road Motors", phone: "+441302000000", location: "Doncaster · Diagnostics & repairs" };
const NOW = new Date("2026-10-26T09:00:00Z");
const SAMPLE_LOGO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 38 38"><rect width="38" height="38" fill="#ffffff"/><path d="M8 26 L19 10 L30 26 Z" fill="#0f766e"/></svg>',
  );

const SERVICES: { id: string; name: string; description: string; duration: number | null; pence: number | null; mode: PriceMode }[] = [
  { id: "diag", name: "Diagnostics", description: "Warning lights, faults, electrical", duration: 60, pence: 4500, mode: "fixed" },
  { id: "service", name: "Full service", description: "Oil, filters, 60+ checks", duration: 150, pence: 18950, mode: "from" },
  { id: "mot", name: "MOT", description: "Class 4", duration: 45, pence: 5485, mode: "fixed" },
  { id: "brakes", name: "Brakes & suspension", description: "Inspected first, then quoted", duration: null, pence: null, mode: "quote" },
  { id: "other", name: "Something else", description: "Tell us and we'll quote", duration: null, pence: null, mode: "quote" },
];

const SYMPTOMS = [
  { value: "warning-light", label: "Warning light" },
  { value: "odd-noise", label: "Odd noise" },
];

const DAYS: DateStripDay[] = Array.from({ length: 14 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 9, 26 + index, 12));
  const key = date.toISOString().slice(0, 10);
  return { date: key, disabled: date.getUTCDay() === 0 || index === 9 };
});

const SLOTS_TUE: TimeSlot[] = [
  { starts_at: "2026-10-27T08:30:00Z", free_count: 2 },
  { starts_at: "2026-10-27T09:15:00Z", free_count: 1 },
  { starts_at: "2026-10-27T10:00:00Z", free_count: 0 },
  { starts_at: "2026-10-27T10:45:00Z", free_count: 2 },
  { starts_at: "2026-10-27T11:30:00Z", free_count: 1 },
  { starts_at: "2026-10-27T13:00:00Z", free_count: 3 },
  { starts_at: "2026-10-27T13:45:00Z", free_count: 0 },
  { starts_at: "2026-10-27T14:30:00Z", free_count: 1 },
  { starts_at: "2026-10-27T15:15:00Z", free_count: 2 },
];

/* Friday 23 Oct 2026 is still British Summer Time (UTC+1): 16:30Z shows as 17:30, under Evening. */
const SLOTS_BST: TimeSlot[] = [
  { starts_at: "2026-10-23T08:00:00Z", free_count: 1 },
  { starts_at: "2026-10-23T11:15:00Z", free_count: 0 },
  { starts_at: "2026-10-23T15:00:00Z", free_count: 2 },
  { starts_at: "2026-10-23T16:30:00Z", free_count: 1 },
];

/* Text inputs are page markup (not in the component list); shown here so Book 4 can be compared. */
const GALLERY_INPUT =
  "h-[52px] rounded-input border border-grey-300 bg-white px-3.5 text-[16px] text-navy-950 placeholder:text-[#6a7686] focus-visible:border-2 focus-visible:border-accent focus-visible:outline-none!";

const ACCENTS = [...ACCENT_PALETTE.map((value) => ({ value, label: value })), { value: "#ffcc00", label: "#ffcc00 (darkened)" }];

function Frame({ title, children, tone = "light", screen = false }: { title: string; children: ReactNode; tone?: "light" | "navy"; screen?: boolean }) {
  return (
    <section aria-label={title} className="flex w-full max-w-[390px] flex-col gap-2 justify-self-center">
      <h2 className="m-0 px-5 font-display text-2xl font-bold tracking-normal text-navy-950 sm:px-0">{title}</h2>
      <div
        data-frame={title}
        className={cn(
          "flex flex-col overflow-hidden leading-[normal] sm:rounded-card sm:border sm:border-grey-200",
          tone === "navy" ? "bg-navy-950 text-white" : "bg-grey-50 text-grey-800",
          screen && "min-h-[844px]",
        )}
      >
        {children}
      </div>
    </section>
  );
}

function ScreenTitle({ children, size = 38 }: { children: ReactNode; size?: 34 | 36 | 38 }) {
  return (
    <h3
      className={cn(
        "m-0 font-display font-extrabold tracking-[-0.01em] text-navy-950",
        size === 38 ? "text-[38px]" : size === 36 ? "text-[36px]" : "text-[34px]",
        "leading-[0.98]",
      )}
    >
      {children}
    </h3>
  );
}

export function ComponentGallery() {
  const [accent, setAccent] = useState<string>(ACCENT_PALETTE[0]);
  const [plate, setPlate] = useState("AB12 CDE");
  const [emptyPlate, setEmptyPlate] = useState("");
  const [badPlate, setBadPlate] = useState(formatPlateInput("zz99"));
  const [service, setService] = useState("diag");
  const [mode, setMode] = useState<"workshop" | "mobile">("workshop");
  const [symptoms, setSymptoms] = useState<string[]>(["warning-light"]);
  const [note, setNote] = useState("");
  const [channel, setChannel] = useState<"sms" | "whatsapp" | "email">("sms");
  const [consent, setConsent] = useState(false);
  const [day, setDay] = useState<string | null>("2026-10-27");
  const [slot, setSlot] = useState<string | null>("2026-10-27T09:15:00Z");
  const [bstSlot, setBstSlot] = useState<string | null>(null);

  const chosen = SERVICES.find((item) => item.id === service);
  const modeLabel = mode === "workshop" ? "Workshop" : "Mobile visit";

  return (
    <div id="af-gallery" style={garageAccentStyle(accent)} className={cn("min-h-screen bg-white text-grey-800", stickyActionBarPadding)}>
      <div className="mx-auto flex max-w-[1320px] flex-col gap-8 px-0 py-8 sm:px-6">
        <div className="flex flex-col gap-3 px-5 sm:px-0">
          <h1 className="m-0 font-display text-[40px] leading-none font-extrabold tracking-[-0.01em] text-navy-950">Booking components</h1>
          <p className="m-0 max-w-2xl text-[15px] leading-normal text-grey-600">
            Every component in <code className="font-mono text-sm">src/components/book</code> with sample data. Dev only; not indexed.
          </p>
          <div role="group" aria-label="Garage accent" className="flex flex-wrap gap-2">
            {ACCENTS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={accent === option.value}
                onClick={() => setAccent(option.value)}
                className={cn(
                  "inline-flex h-11 items-center gap-2 rounded-input border bg-white px-3 font-mono text-[13px] font-medium text-grey-800",
                  "focus-visible:outline-3! focus-visible:outline-offset-2! focus-visible:outline-accent!",
                  accent === option.value ? "border-2 border-navy-950" : "border-grey-300",
                )}
              >
                <span aria-hidden="true" className="size-4 rounded-full" style={{ background: option.value }} />
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-x-8 gap-y-12 md:grid-cols-2 xl:grid-cols-3">
          {/* Book 1 · Vehicle */}
          <Frame title="Book 1 · Vehicle" screen>
            <GarageHeader name={GARAGE.name} subtitle={GARAGE.location} phone={GARAGE.phone} />
            <StepProgress step={1} className="px-5 pt-4" />
            <div className="flex flex-col gap-[18px] px-5 pt-[22px] pb-6">
              <div className="flex flex-col gap-2">
                <ScreenTitle>What are we booking in?</ScreenTitle>
                <p className="m-0 text-[15px] leading-normal text-grey-600">
                  Enter your registration and we&apos;ll find the car. Takes about a minute, no account needed.
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <PlateInput value={plate} onChange={setPlate} />
                <button
                  type="button"
                  className="flex h-12 items-center justify-center gap-2 rounded-control border-[1.5px] border-navy-950 bg-white text-[15px] font-bold text-navy-950 focus-visible:outline-3! focus-visible:outline-offset-2! focus-visible:outline-accent!"
                >
                  <Search size={18} strokeWidth={2} aria-hidden="true" />
                  Find my car
                </button>
              </div>
              <VehicleCard
                make="Ford"
                model="Focus Titanium"
                year={2018}
                engine="1.0 EcoBoost petrol"
                colour="Blue"
                motEnabled
                motExpiry="2027-03-14"
                lastMileage={48210}
                selected
                now={NOW}
              />
              <div className="flex justify-between text-[14px] font-semibold">
                <a href="#af-gallery" className="text-accent underline">Not your car?</a>
                <a href="#af-gallery" className="text-accent underline">Enter details manually</a>
              </div>
              <div className="flex flex-col gap-2.5 pt-1 text-[13px] text-grey-700">
                <p className="m-0 flex items-center gap-2.5">
                  <User size={18} strokeWidth={2} aria-hidden="true" className="text-grey-600" />
                  Book as a guest, no account or password
                </p>
                <p className="m-0 flex items-center gap-2.5">
                  <Shield size={18} strokeWidth={2} aria-hidden="true" className="text-grey-600" />
                  Your registration never appears in links or analytics
                </p>
              </div>
            </div>
            <StickyActionBar fixed={false} className="mt-auto" label="Continue" href="#book-2" footnote="Powered by Autofix" />
          </Frame>

          {/* Book 2 · Service */}
          <Frame title="Book 2 · Service" screen>
            <GarageHeader name={GARAGE.name} subtitle={`Ford Focus · ${plate || "AB12 CDE"}`} back={{ href: "#af-gallery", label: "Back to vehicle" }} />
            <StepProgress step={2} className="px-5 pt-4" />
            <div id="book-2" className="flex flex-col gap-4 px-5 pt-5 pb-6">
              <ScreenTitle size={36}>What does it need?</ScreenTitle>
              <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                <legend className="sr-only">Choose a service</legend>
                {SERVICES.map((item) => (
                  <ServiceOption
                    key={item.id}
                    name="gallery-service"
                    value={item.id}
                    label={item.name}
                    description={item.description}
                    durationMinutes={item.duration}
                    pricePence={item.pence}
                    priceMode={item.mode}
                    checked={service === item.id}
                    onSelect={setService}
                  />
                ))}
              </fieldset>
              <SegmentedControl
                label="Where?"
                options={[
                  { value: "workshop", label: "At the workshop" },
                  { value: "mobile", label: "Mobile visit" },
                ]}
                value={mode}
                onChange={setMode}
              />
              <SymptomChips options={SYMPTOMS} selected={symptoms} onChange={setSymptoms} note={note} onNoteChange={setNote} />
            </div>
            <StickyActionBar fixed={false} className="mt-auto" label="Choose a time" href="#book-3" />
          </Frame>

          {/* Book 3 · Time */}
          <Frame title="Book 3 · Time" screen>
            <GarageHeader
              name={GARAGE.name}
              subtitle={chosen ? `${chosen.name}${chosen.duration ? " · 1 hr" : ""} · ${modeLabel}` : modeLabel}
              back={{ href: "#book-2", label: "Back to service" }}
            />
            <StepProgress step={3} className="px-5 pt-4" />
            <div id="book-3" className="flex flex-col gap-4 pt-5 pb-6">
              <div className="flex items-end justify-between gap-3 px-5">
                <ScreenTitle size={36}>Pick a time</ScreenTitle>
                <span className="flex items-center gap-1.5 pb-1 text-[12px] font-semibold text-success-ink">
                  <span aria-hidden="true" className="size-2 rounded-full bg-success" />
                  Live from the diary
                </span>
              </div>
              <DateStrip days={DAYS} selected={day} onSelect={setDay} />
              <SlotGrid
                className="px-5"
                slots={day === "2026-10-27" ? SLOTS_TUE : []}
                selected={slot}
                onSelect={setSlot}
                timeZone="Europe/London"
              />
              {slot && day === "2026-10-27" ? (
                <div className="mx-5 mt-1 flex items-start gap-3 rounded-control border border-grey-200 bg-white p-3.5">
                  <Clock size={20} strokeWidth={2} aria-hidden="true" className="mt-px shrink-0 text-grey-600" />
                  <p className="m-0 text-[13.5px] leading-[1.45] text-grey-700">
                    Drop off at <strong className="text-navy-950">{formatTime(slot)}</strong>. Expected ready around{" "}
                    {formatTime(new Date(Date.parse(slot) + 60 * 60_000))}. We&apos;ll text you when it&apos;s done.
                  </p>
                </div>
              ) : null}
            </div>
            <StickyActionBar
              fixed={false}
              className="mt-auto"
              label={slot ? formatSlotLabel(slot) : "Choose a time"}
              disabled={!slot}
              onClick={() => undefined}
            />
          </Frame>

          {/* Book 4 · Details */}
          <Frame title="Book 4 · Details" screen>
            <GarageHeader name={GARAGE.name} subtitle="Almost done" back={{ href: "#book-3", label: "Back to time" }} />
            <StepProgress step={4} className="px-5 pt-4" />
            <div className="flex flex-col gap-3.5 px-5 pt-[18px] pb-6">
              <BookingSummaryBar
                registration={plate || "AB12CDE"}
                service={chosen?.name ?? "Diagnostics"}
                mode={modeLabel}
                start={slot ?? "2026-10-27T09:15:00Z"}
                editHref="#book-3"
              />
              <div className="mt-1">
                <ScreenTitle size={34}>Who&apos;s dropping it off?</ScreenTitle>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="gallery-name" className="text-[14px] font-semibold">Full name</label>
                <input id="gallery-name" autoComplete="name" defaultValue="Sarah Okafor" className={GALLERY_INPUT} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="gallery-mobile" className="text-[14px] font-semibold">Mobile number</label>
                <input id="gallery-mobile" type="tel" autoComplete="tel" placeholder="07700 900000" className={GALLERY_INPUT} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="gallery-email" className="text-[14px] font-semibold">
                  Email <span className="font-normal text-grey-600">(for your receipt)</span>
                </label>
                <input id="gallery-email" type="email" autoComplete="email" placeholder="you@example.com" className={GALLERY_INPUT} />
              </div>
              <SegmentedControl
                label="Updates by"
                variant="outline"
                options={[
                  { value: "sms", label: "Text" },
                  { value: "whatsapp", label: "WhatsApp" },
                  { value: "email", label: "Email" },
                ]}
                value={channel}
                onChange={setChannel}
              />
              <ConsentCheckbox checked={consent} onCheckedChange={setConsent} />
            </div>
            <StickyActionBar
              fixed={false}
              className="mt-auto"
              label="Confirm booking"
              showArrow={false}
              type="button"
              footnote={
                <>
                  Nothing to pay now.{" "}
                  <a href="#af-gallery" className="text-grey-700 underline">How we use your details</a>
                </>
              }
            />
          </Frame>

          {/* Book 5 · Confirmed */}
          <Frame title="Book 5 · Confirmed" tone="navy" screen>
            <GarageHeader name={GARAGE.name} tone="plain" />
            <div className="flex flex-col items-center gap-[22px] px-6 pt-9 pb-7 text-center">
              <span aria-hidden="true" className="flex size-[84px] items-center justify-center rounded-full bg-success outline-[10px] outline-[rgba(22,163,74,0.18)] outline-solid">
                <Check size={40} strokeWidth={3} className="text-white" />
              </span>
              <div className="flex flex-col gap-2">
                <h3 className="m-0 font-display text-[44px] leading-[0.95] font-extrabold tracking-[-0.01em] text-white">You&apos;re booked in</h3>
                <p className="m-0 text-[15px] leading-normal text-[#b8c4d4]">We&apos;ve texted your confirmation to 07••• •••412.</p>
              </div>
              <ConfirmationCard
                reference="HRM-4821"
                when={formatSlotLabel(slot ?? "2026-10-27T09:15:00Z")}
                vehicle={`Ford Focus · ${plate || "AB12 CDE"}`}
                service={chosen?.name ?? "Diagnostics"}
                location="Workshop, DN1"
                calendarHref="#af-gallery"
                manageHref="#af-gallery"
                whatsappHref="#af-gallery"
              />
              <a href="#af-gallery" className="text-[13px] text-[#9cc8ff] underline">Book another car</a>
              <span className="text-[11px] text-[#8796ab]">Powered by Autofix</span>
            </div>
          </Frame>

          {/* States */}
          <Frame title="Header and progress states">
            <GarageHeader name="Kwik Lane Garage" subtitle="No phone on file: no call button" />
            <GarageHeader name={GARAGE.name} logoUrl={SAMPLE_LOGO} subtitle="With a logo" phone={GARAGE.phone} />
            <div className="flex flex-col gap-5 px-5 py-5">
              {[1, 2, 3, 4].map((step) => (
                <StepProgress key={step} step={step} />
              ))}
            </div>
          </Frame>

          <Frame title="Plate states">
            <div className="flex flex-col gap-5 px-5 py-5">
              <PlateInput value={emptyPlate} onChange={setEmptyPlate} label="Empty (placeholder)" hint="Current plates are spaced for you: AB12 CDE" />
              <PlateInput value={badPlate} onChange={setBadPlate} label="With an error" error="We couldn't find that registration. Check it or enter the car's details." />
              <PlateInput value="" onChange={() => undefined} label="Disabled" disabled />
              <div className="flex flex-wrap items-center gap-3">
                <PlateChip registration="AB12CDE" />
                <PlateChip registration="A123BCD" size="md" />
                <PlateChip registration="ABC123D" />
              </div>
            </div>
          </Frame>

          <Frame title="Vehicle card states">
            <div className="flex flex-col gap-3 px-5 py-5">
              <VehicleCard make="Ford" model="Focus Titanium" year={2018} engine="1.0 EcoBoost petrol" colour="Blue" motEnabled={false} motExpiry="2027-03-14" lastMileage={48210} now={NOW} />
              <VehicleCard make="Vauxhall" model="Corsa" year={2015} colour="Red" motEnabled motExpiry="2026-11-10" now={NOW} />
              <VehicleCard make="Toyota" model="Yaris" year={2012} motEnabled motExpiry="2026-09-30" lastMileage={102344} now={NOW} />
              <VehicleCard make="Volkswagen" motEnabled />
            </div>
          </Frame>

          <Frame title="Slot grid states">
            <div className="flex flex-col gap-4 py-5">
              <p className="m-0 px-5 text-[13px] text-grey-600">Fri 23 Oct (BST): 16:30 UTC is 17:30 local, under Evening.</p>
              <SlotGrid className="px-5" slots={SLOTS_BST} selected={bstSlot} onSelect={setBstSlot} timeZone="Europe/London" />
              <SlotGrid className="px-5" slots={[]} selected={null} onSelect={() => undefined} />
            </div>
          </Frame>

          <Frame title="Choices and consent states">
            <div className="flex flex-col gap-4 px-5 py-5">
              <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                <legend className="mb-2 text-sm font-semibold text-grey-800">Uncontrolled form fields</legend>
                <ServiceOption name="gallery-plain" value="a" label="Fixed price" description="Paid on collection" durationMinutes={75} pricePence={4550} priceMode="fixed" defaultChecked />
                <ServiceOption name="gallery-plain" value="b" label="From price" durationMinutes={30} pricePence={12000} priceMode="from" />
                <ServiceOption name="gallery-plain" value="c" label="Not bookable online" description="Call the garage" pricePence={null} priceMode="quote" disabled />
              </fieldset>
              <SegmentedControl
                label="One option disabled"
                options={[
                  { value: "workshop", label: "At the workshop" },
                  { value: "mobile", label: "Mobile visit", disabled: true },
                ]}
                value="workshop"
                onChange={() => undefined}
              />
              <ConsentCheckbox name="gallery-consent" motEnabled={false} />
              <SymptomChips options={[...SYMPTOMS, { value: "vibration", label: "Vibration" }]} selected={[]} onChange={() => undefined} />
            </div>
          </Frame>

          <Frame title="Action bar states">
            <div className="flex flex-col gap-3 py-5">
              <StickyActionBar fixed={false} label="Sending" busy onClick={() => undefined} />
              <StickyActionBar fixed={false} label="Choose a time" disabled onClick={() => undefined} />
              <ConfirmationCard
                className="px-5"
                reference="HRM-0042"
                when="Wed 28 Oct, 13:00"
                vehicle="Vauxhall Corsa · AB15 XYZ"
                service="Full service"
                location="Mobile visit, DN4"
                calendarHref="#af-gallery"
              />
            </div>
          </Frame>
        </div>
      </div>

      <div data-demo-fixed>
        <StickyActionBar
          label={slot ? formatSlotLabel(slot) : "Choose a time"}
          disabled={!slot}
          onClick={() => undefined}
          footnote="Fixed bar demo: page content needs stickyActionBarPadding"
        />
      </div>
    </div>
  );
}
